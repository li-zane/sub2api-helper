import { createHash } from 'node:crypto';

const fingerprint = proxy => createHash('sha256').update(JSON.stringify([proxy.url, proxy.ipAddress])).digest('hex');
const parse = value => value ? JSON.parse(value) : null;
export function confirmedExit(result) {
  return result?.status === 'ok' && result.stable === true && result.exits?.length === 1 ? result.exits[0] : null;
}

// Persist attempts as well as successful reports. Missing records are checked once,
// while an explicit retest can refresh a failure without a polling retry storm.
export class ProxyDiagnostics {
  constructor({ service, canRun = () => true, onResult = () => {} }) {
    Object.assign(this, { service, canRun, onResult });
    this.queue = new Map();
    this.pending = new Map();
    this.closed = false;
  }
  load(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS proxy_diagnostics (
      pool TEXT NOT NULL, node INTEGER NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(pool,node)
    );
    CREATE TABLE IF NOT EXISTS proxy_exit_details (
      pool TEXT NOT NULL, ip TEXT NOT NULL, details TEXT NOT NULL, PRIMARY KEY(pool,ip)
    );`);
    this.read = db.prepare('SELECT fingerprint,result FROM proxy_diagnostics WHERE pool=? AND node=?');
    this.put = db.prepare('INSERT OR REPLACE INTO proxy_diagnostics VALUES(?,?,?,?)');
    this.readExit = db.prepare('SELECT details FROM proxy_exit_details WHERE pool=? AND ip=?');
    this.putExit = db.prepare('INSERT OR REPLACE INTO proxy_exit_details VALUES(?,?,?)');
  }
  key(pool, proxy) { return `${pool}:${proxy.id}:${fingerprint(proxy)}`; }
  get(pool, proxy) {
    const row = this.read?.get(pool, proxy.id);
    return row?.fingerprint === fingerprint(proxy) ? parse(row.result) : null;
  }
  exit(pool, ip) { return parse(this.readExit?.get(pool, ip)?.details); }
  remember(pool, proxy, ip = proxy.ipAddress, report = null) {
    if (!ip) return;
    const before = this.exit(pool, ip) || {};
    const nodes = new Map((before.nodes || []).map(node => [node.id, node]));
    nodes.set(proxy.id, { id: proxy.id, name: proxy.name, protocol: proxy.protocol, host: proxy.host, port: proxy.port });
    const next = { ...before, ...(report ? { quality: report } : {}), nodes: [...nodes.values()] };
    if (JSON.stringify(next) !== JSON.stringify(before)) this.putExit.run(pool, ip, JSON.stringify(next));
  }
  save(pool, proxy, result) {
    this.db.exec('BEGIN');
    try {
      this.put.run(pool, proxy.id, fingerprint(proxy), JSON.stringify(result));
      this.remember(pool, proxy, proxy.ipAddress, result);
      for (const exit of result.exits || []) this.remember(pool, proxy, exit.ip, { ...result, exits: [exit] });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.onResult(pool, proxy, result);
    return result;
  }
  summary(pool, proxy) {
    const quality = this.get(pool, proxy), exit = confirmedExit(quality);
    return { quality, qualityPending: this.queue.has(this.key(pool, proxy)) || this.pending.has(this.key(pool, proxy)),
      detectedIpAddress: exit?.ip || null, city: exit?.city || null, region: exit?.region || null,
      country: exit?.country || null, countryCode: exit?.countryCode || null };
  }
  enqueue(pool, proxies) {
    if (this.closed || !this.db || !pool) return;
    for (const proxy of proxies) {
      this.remember(pool, proxy);
      if (proxy.url && !this.get(pool, proxy) && !this.pending.has(this.key(pool, proxy))) this.queue.set(this.key(pool, proxy), { pool, proxy });
    }
    if (!this.worker) this.worker = Promise.resolve().then(() => this.drain()).finally(() => { this.worker = null; });
  }
  async drain() {
    while (!this.closed && this.queue.size && this.canRun()) {
      const [key, entry] = this.queue.entries().next().value;
      this.queue.delete(key);
      if (this.get(entry.pool, entry.proxy)) continue;
      try { await this.check(entry.pool, entry.proxy); } catch { /* Next observation retries admission failures. */ }
    }
    this.queue.clear();
  }
  check(pool, proxy, { signal } = {}) {
    const key = this.key(pool, proxy);
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.closed) return Promise.reject(Object.assign(Error('服务正在关闭'), { status: 503 }));
    this.queue.delete(key);
    const work = this.service.check(proxy.url, { signal, rotateSession: false }).then(result => this.save(pool, proxy, result))
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
  async close() {
    this.closed = true;
    this.queue.clear();
    await this.service.close();
    await Promise.allSettled([...this.pending.values(), this.worker].filter(Boolean));
  }
}
