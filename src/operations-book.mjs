import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { ProxyActivity } from "./proxy-activity.mjs";
import {
  normalizeAccountCost,
  accountProfitCents,
} from "../shared/account-pricing.mjs";

export const beijingDay = (time) => {
  const n = new Date(time).getTime();
  return Number.isFinite(n)
    ? new Date(n + 8 * 3600000).toISOString().slice(0, 10)
    : null;
};
export const cents = (v) => Math.round(normalizeAccountCost(v) * 100);
const iso = (time) =>
  Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : null;
const failure = (status, msg) => Object.assign(Error(msg), { status });
const QUALITY_PAGE_SIZE = 50;
const QUALITY_STATUSES = new Set(["match", "mismatch", "unknown", "error"]);
const QUALITY_METHODS = new Set(["fingerprint", "candy", "regex"]);
const QUALITY_SOURCES = new Set(["manual", "scheduled", "import"]);

export class OperationsBook {
  constructor(file, now = () => Date.now()) {
    this.file = file;
    this.now = now;
    this.qualitySummaries = new Map();
  }
  open() {
    this.qualitySummaries.clear();
    const db = (this.db = new DatabaseSync(this.file));
    chmodSync(this.file, 0o600);
    db.exec("PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;");
    this.proxyActivity = new ProxyActivity(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_rules(pool TEXT NOT NULL,id INTEGER NOT NULL,blocked INTEGER NOT NULL,PRIMARY KEY(pool,id));
      CREATE TABLE IF NOT EXISTS ips(pool TEXT NOT NULL,ip TEXT NOT NULL,added TEXT,cost INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(pool,ip));
      CREATE TABLE IF NOT EXISTS pauses(account TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS quality(account TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(account,at));
      CREATE TABLE IF NOT EXISTS quality_observations(
        account TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL,
        method TEXT, source TEXT, PRIMARY KEY(account,id)
      );
      CREATE INDEX IF NOT EXISTS quality_observations_account_time ON quality_observations(account,at);
      INSERT OR IGNORE INTO quality_observations(account,id,at,status)
        SELECT q.account, 'legacy:' || q.at || ':' || q.status, q.at, q.status
        FROM quality q WHERE q.status IN ('match','mismatch') AND NOT EXISTS (
          SELECT 1 FROM quality_observations o WHERE o.account=q.account AND o.at=q.at AND o.status=q.status
        );
      CREATE TABLE IF NOT EXISTS days(day TEXT PRIMARY KEY,sampled TEXT,complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS period_close(day TEXT PRIMARY KEY,pool TEXT NOT NULL,rate REAL NOT NULL,closed TEXT);
      CREATE TABLE IF NOT EXISTS expenses(day TEXT NOT NULL,kind TEXT NOT NULL,entity TEXT NOT NULL,cents INTEGER NOT NULL,PRIMARY KEY(kind,entity));
      CREATE TABLE IF NOT EXISTS income(day TEXT NOT NULL,entity TEXT NOT NULL,cents INTEGER,sampled TEXT,PRIMARY KEY(day,entity));
      CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,account TEXT NOT NULL,pool TEXT NOT NULL,remote TEXT NOT NULL,model TEXT NOT NULL,question TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',state TEXT NOT NULL,created TEXT NOT NULL,error TEXT);
      CREATE INDEX IF NOT EXISTS chats_account ON chats(account,created);
      UPDATE chats SET state='interrupted',error='服务重启中断了本轮；未自动重发' WHERE state='running';
    `);
    const chatColumns = new Set(db.prepare("PRAGMA table_info(chats)").all().map(({ name }) => name));
    if (!chatColumns.has("conversation")) db.exec("ALTER TABLE chats ADD COLUMN conversation TEXT");
    if (!chatColumns.has("image_requested")) db.exec("ALTER TABLE chats ADD COLUMN image_requested INTEGER NOT NULL DEFAULT 0");
    if (!chatColumns.has("image_type")) db.exec("ALTER TABLE chats ADD COLUMN image_type TEXT");
    if (!chatColumns.has("image")) db.exec("ALTER TABLE chats ADD COLUMN image BLOB");
    db.exec("CREATE INDEX IF NOT EXISTS chats_conversation ON chats(account,pool,remote,conversation,created)");
    this.blocked = new Set(
      db
        .prepare("SELECT pool,id FROM proxy_rules WHERE blocked=1")
        .all()
        .map((r) => r.pool + ":" + r.id),
    );
    this.pauses = new Set(
      db
        .prepare("SELECT account FROM pauses")
        .all()
        .map((r) => r.account),
    );
  }
  close() {
    this.db?.close();
    this.db = null;
  }
  today() {
    return beijingDay(this.now());
  }
  paused(email) {
    return this.pauses?.has(String(email).toLowerCase()) || false;
  }
  pause(email, v) {
    const key = email.toLowerCase();
    if (typeof v !== "boolean") throw failure(400, "请指定巡检暂停状态");
    this.db
      .prepare(
        v
          ? "INSERT OR IGNORE INTO pauses VALUES(?)"
          : "DELETE FROM pauses WHERE account=?",
      )
      .run(key);
    if (v) this.pauses.add(key);
    else this.pauses.delete(key);
  }
  isBlocked(pool, id) {
    return this.blocked?.has(pool + ":" + id) || false;
  }
  policy(pool, id, ip) {
    const row = this.db
      ?.prepare("SELECT added,cost FROM ips WHERE pool=? AND ip=?")
      .get(pool, ip);
    return {
      allocationPaused: this.isBlocked(pool, id),
      ipCostCny: (row?.cost || 0) / 100,
      ipAddedAt: row?.added || null,
    };
  }
  seeIp(pool, ip, created) {
    if (!ip) return;
    const at = iso(created);
    this.db
      .prepare(
        "INSERT INTO ips(pool,ip,added) VALUES(?,?,?) ON CONFLICT(pool,ip) DO UPDATE SET added=excluded.added WHERE excluded.added IS NOT NULL AND(ips.added IS NULL OR ips.added>excluded.added)",
      )
      .run(pool, ip, at);
  }
  savePolicy(pool, id, ip, created, body) {
    const hasPause = Object.hasOwn(body, "allocationPaused"), hasCost = Object.hasOwn(body, "ipCostCny");
    if (!ip || (!hasPause && !hasCost) || (hasPause && typeof body.allocationPaused !== "boolean"))
      throw failure(400, "缺少代理 IP 或分配状态");
    let price;
    try {
      if (hasCost) price = cents(body.ipCostCny);
    } catch {
      throw failure(400, "IP 成本必须为有效的非负人民币金额，最多两位小数");
    }
    this.db.exec("BEGIN");
    try {
      this.seeIp(pool, ip, created);
      if (hasCost) this.db
        .prepare("UPDATE ips SET cost=? WHERE pool=? AND ip=?")
        .run(price, pool, ip);
      if (hasPause) this.db
        .prepare("INSERT OR REPLACE INTO proxy_rules VALUES(?,?,?)")
        .run(pool, id, +body.allocationPaused);
      const row = this.db
        .prepare("SELECT added FROM ips WHERE pool=? AND ip=?")
        .get(pool, ip);
      if (hasCost) this.expense("ip", pool + ":" + ip, row.added, price);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    if (hasPause) {
      if (body.allocationPaused) this.blocked.add(pool + ":" + id);
      else this.blocked.delete(pool + ":" + id);
    }
    return this.policy(pool, id, ip);
  }
  expense(kind, entity, added, price) {
    const day = added && beijingDay(added);
    if (day !== this.today()) return;
    this.db.prepare("INSERT OR IGNORE INTO days(day) VALUES(?)").run(day);
    this.db
      .prepare(
        "INSERT INTO expenses VALUES(?,?,?,?) ON CONFLICT(kind,entity) DO UPDATE SET cents=excluded.cents WHERE expenses.day=excluded.day",
      )
      .run(day, kind, entity, price);
  }
  recordQuality(account, at, status, round = {}) {
    const time = iso(at);
    if (!time || !QUALITY_STATUSES.has(status)) return;
    const key = account.toLowerCase();
    const legacyId = `legacy:${time}:${status}`;
    const id = typeof round.id === "string" && round.id.trim() ? round.id : legacyId;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        "INSERT OR IGNORE INTO quality_observations VALUES(?,?,?,?,?,?)",
      ).run(key, id, time, status, QUALITY_METHODS.has(round.method) ? round.method : null,
        QUALITY_SOURCES.has(round.source) ? round.source : null);
      if (id !== legacyId) {
        this.db.prepare("DELETE FROM quality_observations WHERE account=? AND id=?").run(key, legacyId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.qualitySummaries.delete(key);
  }

  qualityPage(account, before = null) {
    const key = account.toLowerCase();
    let rows;
    if (before === null) {
      rows = this.db.prepare(
        "SELECT rowid, id, at, status, method, source FROM quality_observations WHERE account=? ORDER BY at DESC, rowid DESC LIMIT ?",
      ).all(key, QUALITY_PAGE_SIZE + 1);
    } else {
      const [time, row] = before.split("|");
      const rowid = Number(row);
      if (before !== `${time}|${rowid}` || iso(time) !== time || !Number.isSafeInteger(rowid) || rowid < 1) {
        throw failure(400, "降智检测记录分页参数无效");
      }
      rows = this.db.prepare(
        "SELECT rowid, id, at, status, method, source FROM quality_observations WHERE account=? AND (at,rowid)<(?,?) ORDER BY at DESC, rowid DESC LIMIT ?",
      ).all(key, time, rowid, QUALITY_PAGE_SIZE + 1);
    }
    const visible = rows.slice(0, QUALITY_PAGE_SIZE);
    const last = visible.at(-1);
    return {
      records: visible.map(({ id, at, status, method, source }) => ({ id, at, status, method, source })),
      nextBefore: rows.length > QUALITY_PAGE_SIZE ? `${last.at}|${last.rowid}` : null,
    };
  }

  quality(account, joined) {
    const key = account.toLowerCase();
    let summary = this.qualitySummaries.get(key);
    if (!summary) {
      const timeline = this.db.prepare(`
        SELECT at, status, previousStatus, method FROM (
          SELECT at, status, method, rowid,
            LAG(status) OVER (ORDER BY at,rowid) AS previousStatus
          FROM quality_observations WHERE account=? AND status IN ('match','mismatch')
        ) WHERE previousStatus IS NULL OR previousStatus <> status ORDER BY at,rowid
      `).all(key);
      const lastCheckedAt = this.db.prepare(
        "SELECT at FROM quality_observations WHERE account=? ORDER BY at DESC, rowid DESC LIMIT 1",
      ).get(key)?.at ?? null;
      summary = { timeline, currentStatus: timeline.at(-1)?.status ?? null, lastCheckedAt };
      this.qualitySummaries.set(key, summary);
    }
    const last = summary.timeline.at(-1), prev = summary.timeline.at(-2);
    if (!last) return { ...summary, kind: "unknown" };
    const elapsed = (a, b) =>
      iso(a) && iso(b) && Date.parse(b) >= Date.parse(a)
        ? Math.floor((Date.parse(b) - Date.parse(a)) / 60000)
        : null;
    if (last.status === "mismatch")
      return {
        ...summary,
        kind: "degraded",
        at: last.at,
        minutesAfterJoin: elapsed(joined, last.at),
      };
    if (prev?.status === "mismatch")
      return {
        ...summary,
        kind: "recovered",
        at: last.at,
        minutesToRecovery: elapsed(prev.at, last.at),
      };
    return { ...summary, kind: "normal", at: last.at };
  }
  recordIncome(
    day,
    observations,
    rate,
    complete,
    { pool = "", close = false } = {},
  ) {
    if (close) {
      const row = this.db
        .prepare("SELECT pool,rate,closed FROM period_close WHERE day=?")
        .get(day);
      if (
        !row ||
        row.closed ||
        day >= this.today() ||
        row.pool !== pool ||
        row.rate !== rate
      )
        return;
    } else if (day !== this.today()) return; // A delayed response never reopens a closed day.
    const sampled = new Date(this.now()).toISOString();
    this.db.exec("BEGIN");
    try {
      for (const [entity, usd] of observations) {
        const revenue = accountProfitCents(usd, rate, 0);
        this.db
          .prepare(
            "INSERT INTO income VALUES(?,?,?,?) ON CONFLICT(day,entity) DO UPDATE SET cents=COALESCE(excluded.cents,income.cents), sampled=CASE WHEN excluded.cents IS NULL THEN income.sampled ELSE excluded.sampled END",
          )
          .run(day, entity, revenue === null ? null : revenue, sampled);
      }
      this.db
        .prepare("INSERT OR REPLACE INTO days VALUES(?,?,?)")
        .run(day, sampled, +complete);
      if (close)
        this.db
          .prepare(
            "UPDATE period_close SET closed=? WHERE day=? AND closed IS NULL",
          )
          .run(sampled, day);
      else
        this.db
          .prepare(
            "INSERT INTO period_close(day,pool,rate) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET rate=excluded.rate,pool=excluded.pool WHERE closed IS NULL",
          )
          .run(day, pool, rate);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  daySummary(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw failure(400, "日期格式错误");
    const record = this.db
      .prepare("SELECT sampled,complete FROM days WHERE day=?")
      .get(day);
    const costs = this.db
      .prepare(
        "SELECT kind,COUNT(*) n,SUM(cents) amount FROM expenses WHERE day=? GROUP BY kind",
      )
      .all(day);
    const income = this.db
      .prepare(
        "SELECT COUNT(*) count,COUNT(cents) known,SUM(cents) amount FROM income WHERE day=?",
      )
      .get(day);
    const cost = (kind) =>
      costs.find((c) => c.kind === kind) || { amount: 0, n: 0 };
    const total = cost("account").amount + cost("ip").amount;
    const revenue =
      record?.sampled && (income.known > 0 || record.complete)
        ? (income.amount ?? 0)
        : null;
    const closedAt =
      this.db.prepare("SELECT closed FROM period_close WHERE day=?").get(day)
        ?.closed || null;
    return {
      day,
      closedAt,
      today: this.today(),
      readOnly: day !== this.today(),
      exists: !!record,
      sampled: record?.sampled || null,
      complete: record?.complete === 1,
      accountCostCents: cost("account").amount,
      ipCostCents: cost("ip").amount,
      accountCount: cost("account").n,
      ipCount: cost("ip").n,
      costCents: total,
      incomeCents: revenue,
      profitCents: revenue === null ? null : revenue - total,
      known: income.known,
      count: income.count,

    };
  }
  ledger(day = this.today()) {
    const end = Date.parse(day + "T00:00:00.000Z");
    if (!Number.isFinite(end) || new Date(end).toISOString().slice(0,10)!==day) throw failure(400, "日期格式错误");
    const current = this.daySummary(day);
    const trend = Array.from({length:7}, (_, i) => {
      const key = new Date(end - (6-i)*86400000).toISOString().slice(0,10);
      const r = key === day ? current : this.daySummary(key);
      return {day:key,exists:r.exists,complete:r.complete,
        costCents:r.exists?r.costCents:null,incomeCents:r.incomeCents,profitCents:r.profitCents};
    });
    return {...current, trend, days:this.db.prepare("SELECT day FROM days ORDER BY day DESC LIMIT 366").all().map(r=>r.day)};
  }
}
