import { createHash } from "node:crypto";

// A node is a protocol endpoint; allocation is ranked at the shared exit level.
export function rotationCityKey(location) {
  const clean = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
  const city = clean(location?.city), country = clean(location?.countryCode || location?.country);
  return city && country ? JSON.stringify([country, clean(location?.region), city]) : null;
}

export function rankRotationExits({ proxies, currentIps, occupiedIps, activity, ipOf, available, currentCities, cityOf }) {
  // The caller supplies confirmed locations. Unknown or conflicting current
  // locations cannot establish a same-city destination.
  if (currentCities && (currentCities.size !== 1 || currentCities.has(null))) return [];
  const city = currentCities ? [...currentCities][0] : null;
  const exits = new Map();
  for (const proxy of proxies) {
    const ip = ipOf(proxy);
    if (!ip || currentIps.has(ip) || !available(proxy) || currentCities && cityOf(proxy) !== city) continue;
    if (!exits.has(ip) || proxy.id < exits.get(ip).id) exits.set(ip, proxy);
  }
  const time = ip => Date.parse(activity.get(ip)?.lastRequestAt) || 0;
  return [...exits].sort(([a], [b]) => Number(occupiedIps.has(a)) - Number(occupiedIps.has(b))
    || (activity.get(a)?.historicalAccountCount || 0) - (activity.get(b)?.historicalAccountCount || 0)
    || time(a) - time(b) || a.localeCompare(b)).map(([, proxy]) => proxy);
}

// Update only proxy_id. A failed/ambiguous write is read back and compensated;
// a concurrent external change is preserved rather than overwritten on rollback.
export async function rebindPoolProxies({ rows, proxyId, read, write, saveLocal, restoreLocal,
  identityOf = row => String(row?.credentials?.email || row?.email || "").toLowerCase() }) {
  const attempted = [];
  const sameAccount = (a, b) => a && String(a.id) === String(b.id)
    && a?.platform === b.platform && a?.type === b.type
    && identityOf(a) === identityOf(b);
  const idOf = row => Number(row?.proxy_id) || 0;
  try {
    for (const row of rows) {
      const before = await read(row.id);
      if (!sameAccount(before, row) || idOf(before) !== idOf(row)) throw Error("号池账号绑定已变化，请重试");
      if (idOf(before) === proxyId) continue;
      attempted.push(before);
      await write(row.id, proxyId);
      const after = await read(row.id);
      if (!sameAccount(after, before) || idOf(after) !== proxyId) throw Error("号池代理换绑校验失败");
    }
    await saveLocal();
  } catch (error) {
    let rollbackFailed = false;
    for (const row of attempted.reverse()) {
      try {
        const current = await read(row.id);
        if (!sameAccount(current, row)) throw Error("账号身份已变化");
        if (idOf(current) === idOf(row)) continue;
        if (idOf(current) !== proxyId) throw Error("绑定已被其他操作修改");
        await write(row.id, idOf(row));
        const restored = await read(row.id);
        if (!sameAccount(restored, row) || idOf(restored) !== idOf(row)) throw Error("回退校验失败");
      } catch { rollbackFailed = true; }
    }
    try { await restoreLocal(); } catch { rollbackFailed = true; }
    if (rollbackFailed) throw Error("IP 换绑失败，部分绑定回退待确认，请检查号池与本地绑定");
    throw error;
  }
}

export class ProxyRotation {
  constructor({ getSettings, canRun, getAccounts, eligible, rotate, now = Date.now, tickMs = 15000, onError = () => {} }) {
    Object.assign(this, { getSettings, canRun, getAccounts, eligible, rotate, now, tickMs, onError });
    this.stopped = true;
    this.generation = 0;
  }
  load(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS proxy_rotation_due (
      pool TEXT NOT NULL, account TEXT NOT NULL, spec TEXT NOT NULL, due INTEGER NOT NULL,
      PRIMARY KEY(pool,account)
    )`);
    this.get = db.prepare("SELECT spec,due FROM proxy_rotation_due WHERE pool=? AND account=?");
    this.put = db.prepare("INSERT OR REPLACE INTO proxy_rotation_due VALUES(?,?,?,?)");
  }
  reset() {
    this.generation++;
    this.db?.exec("DELETE FROM proxy_rotation_due");
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick().catch(this.onError); }, this.tickMs);
    this.timer.unref?.();
    void this.tick().catch(this.onError);
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.scan().finally(() => { this.running = null; });
    return this.running;
  }
  async scan() {
    const settings = this.getSettings();
    if (this.stopped || !settings.enabled || !this.canRun()) return;
    const generation = this.generation, spec = JSON.stringify(settings), interval = settings.intervalMinutes * 60000;
    const { pool, accounts } = this.getAccounts();
    if (!pool) return;
    for (const account of accounts) {
      if (this.stopped || generation !== this.generation || !this.canRun()) break;
      const key = createHash("sha256").update(account.email.toLowerCase()).digest("hex");
      const state = this.get.get(pool, key);
      if (!state || state.spec !== spec) { this.put.run(pool, key, spec, this.now() + interval); continue; }
      if (state.due > this.now() || !this.eligible(account, settings)) continue;
      let success = false;
      try { success = await this.rotate(account, settings, () => !this.stopped && generation === this.generation && this.canRun()); }
      catch (error) { this.onError(error, account); }
      if (generation !== this.generation) break;
      // Busy/no-candidate accounts retry later; failures never spin each scan.
      this.put.run(pool, key, spec, this.now() + (success ? interval : Math.min(interval, 5 * 60000)));
    }
  }
  async stop() { this.stopped = true; clearInterval(this.timer); await this.running; }
}
