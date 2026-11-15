import crypto from 'node:crypto';

export function isMissingPoolGroup(error) {
  return error?.remoteCode === 'GROUP_NOT_FOUND' || /\b(?:GROUP_NOT_FOUND|groups? (?:not found|does not exist))\b/i.test(String(error?.message || error || ''));
}

// Only complete successful reads may establish that a group was deleted.
export class Sub2ApiGroupReferences {
  constructor({ request, onCatalog = async () => {}, now = Date.now, ttlMs = 60_000 }) {
    Object.assign(this, { request, onCatalog, now, ttlMs });
    this.cache = new Map();
    this.pending = new Map();
  }
  key(config) {
    return crypto.createHash('sha256').update(`${config.baseUrl}\0${config.adminApiKey}`).digest('hex');
  }
  async catalog(config, force = false) {
    const key = this.key(config), cached = this.cache.get(key);
    if (!force && cached && this.now() - cached.at < this.ttlMs) return cached.ids;
    if (this.pending.has(key)) return this.pending.get(key);
    const read = (async () => {
      const results = await Promise.allSettled(['openai', 'composite'].map(async platform => {
        const payload = await this.request(config, `/api/v1/admin/groups/all?platform=${platform}`);
        const rows = Array.isArray(payload) ? payload : payload?.data;
        if (!Array.isArray(rows) || rows.some(row => !row || !['number', 'string'].includes(typeof row.id) || !Number.isSafeInteger(Number(row.id)) || Number(row.id) < 1)) throw new Error('号池分组目录不完整');
        if (payload?.has_more === true || payload?.next_cursor || Number(payload?.pages) > 1 || Number(payload?.total) > rows.length) throw new Error('号池分组目录不完整');
        return rows.filter(row => !row.deleted_at && !['deleted', 'removed'].includes(String(row.status).toLowerCase())).map(row => String(row.id));
      }));
      if (results.some(result => result.status === 'rejected')) throw new Error('号池分组目录读取失败，保留现有配置');
      const ids = new Set(results.flatMap(result => result.value));
      this.cache.set(key, { at: this.now(), ids });
      return ids;
    })();
    this.pending.set(key, read);
    try { return await read; } finally { this.pending.delete(key); }
  }
  async resolve(config, ids, { force = false } = {}) {
    if (!Array.isArray(ids) || !ids.length) return { ids, missing: [] };
    const cached = this.cache.get(this.key(config));
    const usedCache = !force && cached && this.now() - cached.at < this.ttlMs;
    let catalog;
    try { catalog = await this.catalog(config, force); }
    catch { return { ids, missing: [], confirmed: false }; }
    let missing = ids.filter(id => !catalog.has(String(id)));
    if (missing.length && usedCache) {
      try { catalog = await this.catalog(config, true); }
      catch { return { ids, missing: [], confirmed: false }; }
      missing = ids.filter(id => !catalog.has(String(id)));
    }
    if (missing.length) await this.onCatalog(config, catalog, missing);
    return { ids: ids.filter(id => catalog.has(String(id))), missing, confirmed: true };
  }
  async write(config, endpoint, options, send) {
    if (String(options.method).toUpperCase() !== 'PUT' || !/^\/api\/v1\/admin\/accounts\/\d+$/.test(endpoint)) return send(config, endpoint, options);
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    if (!Array.isArray(body?.group_ids) || !body.group_ids.length) return send(config, endpoint, options);
    try { return await send(config, endpoint, options); }
    catch (error) {
      if (!isMissingPoolGroup(error)) throw error;
      const resolved = await this.resolve(config, body.group_ids, { force: true });
      if (!resolved.missing.length) throw error;
      const corrected = { ...body, group_ids: resolved.ids };
      // Cleanup must not clear other memberships when every target was deleted.
      if (!resolved.ids.length) delete corrected.group_ids;
      return send(config, endpoint, { ...options, body: JSON.stringify(corrected) });
    }
  }
}
