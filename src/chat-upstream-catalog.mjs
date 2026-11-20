const problem = (status, message) =>
  Object.assign(new Error(message), { status });

// Only the ID list from the gateway's native "sync upstream" operation is
// authoritative. Metadata may also contain configured mappings not in the list.
export function parseSyncedAccountModels(payload) {
  const ids = payload?.data?.models;
  if (
    (payload?.code !== undefined && payload.code !== 0) ||
    !Array.isArray(ids) ||
    !ids.every(
      (id) =>
        typeof id === "string" &&
        id.trim() &&
        !/[\u0000-\u001f\u007f]/u.test(id),
    )
  ) {
    throw problem(502, "Sub2API 未返回有效的账号模型目录");
  }
  return {
    models: [...new Set(ids)],
    hasWarnings:
      Array.isArray(payload.data.warnings) && payload.data.warnings.length > 0,
  };
}

export function createChatCatalog({
  request,
  identity,
  now = Date.now,
  ttl = 60_000,
}) {
  const cached = new Map(),
    pending = new Map();
  return async function get(target, { fresh = false } = {}) {
    const id = String(target.id);
    if (!/^[1-9]\d{0,18}$/.test(id)) throw problem(400, "无效的号池账号 ID");
    const key = JSON.stringify([identity(target.c), target.account, id]);
    if (pending.has(key)) return pending.get(key);
    const old = cached.get(key);
    if (!fresh && old && now() - old.at < ttl) return old.catalog;
    cached.delete(key);
    const work = (async () => {
      let response;
      try {
        // Same authenticated operation as the Sub2API account page. The
        // gateway owns credential resolution, the bound proxy and its client
        // settings. No account token, export, or UA is needed in this path.
        response = await request(
          target.c,
          "/api/v1/admin/accounts/" + id + "/models/sync-upstream",
          {
            method: "POST",
            body: "{}",
            timeoutMs: 60_000,
          },
        );
      } catch (error) {
        const remote = Number(error?.remoteStatus);
        const code =
          Number.isInteger(remote) && remote >= 400 && remote <= 599
            ? "（HTTP " + remote + "）"
            : "";
        if (error?.status === 504)
          throw problem(504, "Sub2API 获取账号上游模型超时，请稍后刷新");
        throw problem(
          502,
          "Sub2API 获取账号上游模型失败" +
            code +
            "，请在 Sub2API 账号页检查后重试",
        );
      }
      const catalog = parseSyncedAccountModels(response);
      if (cached.size >= 128) cached.delete(cached.keys().next().value);
      cached.set(key, { at: now(), catalog });
      return catalog;
    })().finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
}
