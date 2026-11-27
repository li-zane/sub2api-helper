import { createHash } from "node:crypto";

const stamp = value => typeof value === "string" ? Date.parse(value) : NaN;
const identity = account => createHash("sha256").update(account).digest("hex");

// Count logical accounts by exit IP. Track attribution separately per upstream
// row because two rows for one account can use different exits concurrently.
export class ProxyActivity {
  constructor(db) {
    this.db = db;
    this.applied = new Map();
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_account_history (
        pool TEXT NOT NULL, ip TEXT NOT NULL, account TEXT NOT NULL, last_request INTEGER,
        PRIMARY KEY(pool,ip,account)
      );
      CREATE TABLE IF NOT EXISTS proxy_observed_binding (
        pool TEXT NOT NULL, remote TEXT NOT NULL, account TEXT NOT NULL, ip TEXT NOT NULL, since INTEGER NOT NULL,
        PRIMARY KEY(pool,remote)
      );
    `);
    this.pairs = db.prepare(`INSERT INTO proxy_account_history VALUES(?,?,?,?)
      ON CONFLICT(pool,ip,account) DO UPDATE SET last_request=excluded.last_request
      WHERE excluded.last_request IS NOT NULL AND (last_request IS NULL OR last_request < excluded.last_request)`);
    this.bindings = db.prepare("SELECT remote,account,ip,since FROM proxy_observed_binding WHERE pool=?");
    this.bind = db.prepare("INSERT OR REPLACE INTO proxy_observed_binding VALUES(?,?,?,?,?)");
    this.unbind = db.prepare("DELETE FROM proxy_observed_binding WHERE pool=? AND remote=?");
    this.stats = db.prepare(`SELECT ip,COUNT(*) AS historicalAccountCount,MAX(last_request) AS lastRequest
      FROM proxy_account_history WHERE pool=? GROUP BY ip`);
  }

  noteBinding(pool, ip, email) {
    if (pool && ip && email) this.pairs.run(pool, ip, identity(email.toLowerCase()), null);
  }

  observe(pool, sequence, rows, observedAt, localBindings = []) {
    if (sequence <= (this.applied.get(pool) || 0)) return;
    const previous = new Map(this.bindings.all(pool).map(row => [row.remote, row]));
    this.db.exec("BEGIN");
    try {
      for (const { id, email, ip, lastUsedAt, accountUpdatedAt, proxyUpdatedAt } of rows) {
        const remote = String(id);
        const account = identity(email ? email.toLowerCase() : "remote:" + remote);
        const old = previous.get(remote);
        previous.delete(remote);
        if (!ip) {
          if (old) this.unbind.run(pool, remote);
          continue;
        }
        const same = old?.ip === ip && old.account === account;
        // A first snapshot may backfill a request after both last configuration
        // changes. An observed move starts a new window at observation time.
        const lastChange = Math.max(stamp(accountUpdatedAt), stamp(proxyUpdatedAt));
        const initialSince = !old && Number.isFinite(lastChange) && lastChange <= observedAt ? lastChange : observedAt;
        const since = same ? old.since : initialSince;
        if (!same) this.bind.run(pool, remote, account, ip, since);
        const request = stamp(lastUsedAt);
        this.pairs.run(pool, ip, account, request >= since && request <= observedAt ? request : null);
      }
      for (const remote of previous.keys()) this.unbind.run(pool, remote);
      for (const { ip, email } of localBindings) this.noteBinding(pool, ip, email);
      this.db.exec("COMMIT");
      this.applied.set(pool, sequence);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  byIp(pool) {
    return new Map(this.stats.all(pool).map(({ ip, historicalAccountCount, lastRequest }) =>
      [ip, { historicalAccountCount, lastRequestAt: lastRequest == null ? null : new Date(lastRequest).toISOString() }]));
  }
}
