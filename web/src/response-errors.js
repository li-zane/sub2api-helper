export async function readJsonResponse(response) {
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : response.status === 204 ? {} : null; }
  catch { data = null; }
  const valid = data !== null && typeof data === "object";
  if (!response.ok || !valid) {
    const detail = valid && typeof data.error === "string" ? data.error.slice(0, 320) : null;
    const error = new Error(detail || `请求失败：HTTP ${response.status}，服务返回${/^\s*</.test(text) ? " HTML 错误页" : "非 JSON 或空响应"}，请稍后重试`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export function workspaceFailureTooltip(workspace, label = "空间不可用") {
  const code = workspace.availabilityCode;
  return [label, code !== null && code !== undefined && String(code).trim()
    ? `错误代码：${String(code).trim()}` : "上游未提供错误代码", workspace.availabilityMessage].filter(Boolean).join("\n");
}
