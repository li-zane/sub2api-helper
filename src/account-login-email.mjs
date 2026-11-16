import fs from "node:fs/promises";
import crypto from "node:crypto";
import { writePrivateJsonAtomic } from "./account-history.mjs";

export function normalizeLoginEmail(value) {
  if (typeof value !== "string") throw Object.assign(Error("请输入有效的登录邮箱"), { status: 400 });
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\x00-\x1f\x7f]|----/.test(email))
    throw Object.assign(Error("请输入有效的登录邮箱"), { status: 400 });
  return email;
}

// The original email remains the private account key for encrypted credentials,
// pool mappings and schedulers. Current login email and immutable change history
// commit in one atomic file, so a crash cannot save one without the other.
export class AccountLoginEmails {
  constructor(file) { this.file = file; this.records = new Map(); this.aliases = new Map(); this.writes = Promise.resolve(); }
  async load() {
    let data;
    try { data = JSON.parse(await fs.readFile(this.file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (data?.version !== 1 || !Array.isArray(data.records)) throw Error("登录邮箱记录格式无效");
    const records = new Map();
    for (const record of data.records) {
      const key = normalizeLoginEmail(record.accountEmail), email = normalizeLoginEmail(record.email);
      if (!Array.isArray(record.changes) || record.changes.some(event => event.type !== "email" || event.stage !== "changed"
        || !event.id || !Number.isFinite(Date.parse(event.at)) || normalizeLoginEmail(event.before?.email) !== event.before.email
        || normalizeLoginEmail(event.after?.email) !== event.after.email)) throw Error("登录邮箱历史格式无效");
      if (records.has(key)) throw Error("登录邮箱记录重复");
      records.set(key, { ...record, accountEmail: key, email });
    }
    const aliases = this.index(records); this.records = records; this.aliases = aliases;
  }
  index(records) {
    const aliases = new Map();
    for (const [key, record] of records) for (const email of [key, record.email, ...record.changes.flatMap(event => [event.before.email, event.after.email])]) {
      if (aliases.has(email) && aliases.get(email) !== key) throw Object.assign(Error("该邮箱已关联其他账号"), { status: 409 });
      aliases.set(email, key);
    }
    return aliases;
  }
  key(email) { const key = String(email || "").trim().toLowerCase(); return this.aliases.get(key) || key; }
  email(accountEmail) { return this.records.get(this.key(accountEmail))?.email || accountEmail; }
  emails(accountEmail) {
    const key = this.key(accountEmail), record = this.records.get(key);
    return [...new Set([key, ...(record ? [record.email, ...record.changes.flatMap(event => [event.before.email, event.after.email])] : [])])];
  }
  history(accountEmail) { return structuredClone(this.records.get(this.key(accountEmail))?.changes || []); }
  update(accountEmail, nextEmail, { expectedEmail, assertAvailable = () => {} } = {}) {
    const work = this.writes.catch(() => {}).then(async () => {
      const key = this.key(normalizeLoginEmail(accountEmail)), email = normalizeLoginEmail(nextEmail), before = this.email(key);
      if (expectedEmail !== undefined && normalizeLoginEmail(expectedEmail) !== before.toLowerCase())
        throw Object.assign(Error("登录邮箱已被其他操作更新，请重新读取后再保存"), { status: 409 });
      if (before.toLowerCase() === email) return false;
      await assertAvailable(email, key);
      const previous = this.records.get(key), changes = [...(previous?.changes || []), {
        id: `email-${crypto.randomUUID()}`, type: "email", stage: "changed", at: new Date().toISOString(),
        before: { email: before }, after: { email },
      }];
      const records = new Map(this.records); records.set(key, { accountEmail: key, email, changes });
      const aliases = this.index(records);
      await writePrivateJsonAtomic(this.file, { version: 1, records: [...records.values()] });
      this.records = records; this.aliases = aliases; return true;
    });
    this.writes = work; return work;
  }
  remove(accountEmail) {
    const work = this.writes.catch(() => {}).then(async () => {
      const key = this.key(accountEmail); if (!this.records.has(key)) return;
      const records = new Map(this.records); records.delete(key);
      await writePrivateJsonAtomic(this.file, { version: 1, records: [...records.values()] });
      this.records = records; this.aliases = this.index(records);
    });
    this.writes = work; return work;
  }
}
