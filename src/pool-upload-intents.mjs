import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writePrivateJsonAtomic } from "./account-history.mjs";
import { poolUploadIdempotencyKey } from "./pool-upload-lock.mjs";

// All instances sharing a file must read-modify-write in one queue. Reading the
// latest file inside that queue also prevents an old instance losing a sibling's
// newly saved intent. Per-account upload locks still cover the actual requests.
const fileTails = new Map();
const plain = value => value !== null && typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

function emailValue(value) {
  if (typeof value !== "string") throw failure("POOL_UPLOAD_EMAIL_INVALID", "上传账号缺少有效邮箱");
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure("POOL_UPLOAD_EMAIL_INVALID", "上传账号缺少有效邮箱");
  return email;
}

function accountEmail(account) {
  return emailValue(account?.credentials?.email ?? account?.extra?.email ?? account?.email);
}

function backend(config) {
  if (!plain(config) || typeof config.baseUrl !== "string") throw failure("POOL_UPLOAD_BACKEND_INVALID", "号池地址格式错误");
  let url;
  try { url = new URL(config.baseUrl); }
  catch { throw failure("POOL_UPLOAD_BACKEND_INVALID", "号池地址格式错误"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw failure("POOL_UPLOAD_BACKEND_INVALID", "号池地址格式错误");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// Avoid JSON's silent coercions (undefined, NaN, Date, functions, sparse arrays)
// so a retry's frozen body has precisely the same native values as the first.
function jsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!Array.isArray(value) && !plain(value)) throw failure("POOL_UPLOAD_PAYLOAD_INVALID", "上传内容必须为原生 JSON 值");
  if (seen.has(value)) throw failure("POOL_UPLOAD_PAYLOAD_INVALID", "上传内容含循环引用");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = Array.from({ length: value.length }, (_, index) => {
      if (!Object.hasOwn(value, index)) throw failure("POOL_UPLOAD_PAYLOAD_INVALID", "上传内容含空数组项");
      return jsonValue(value[index], seen);
    });
  } else {
    if (Object.getOwnPropertySymbols(value).length) throw failure("POOL_UPLOAD_PAYLOAD_INVALID", "上传内容含非 JSON 字段");
    result = Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonValue(value[key], seen)]));
  }
  seen.delete(value);
  return result;
}

function accountValue(value) {
  if (!plain(value)) throw failure("POOL_UPLOAD_PAYLOAD_INVALID", "上传账号必须为对象");
  const account = jsonValue(value);
  accountEmail(account);
  return account;
}

function idsValue(ids) {
  if (!Array.isArray(ids) || !ids.length) throw failure("POOL_UPLOAD_IDS_INVALID", "确认上传需要正整数账号 ID");
  return [...new Set(ids.map(id => {
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
    if (typeof id === "string" && /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id))) return id;
    throw failure("POOL_UPLOAD_IDS_INVALID", "确认上传需要正整数账号 ID");
  }))];
}

function scopeFor(origin, email) {
  // Only a digest of the backend identity is persisted, never admin API keys or
  // other connection configuration. Changing an API key retains the same scope.
  return crypto.createHash("sha256").update(`${origin}\0${email}`).digest("hex");
}

async function serialized(file, operation) {
  const queueKey = process.platform === "win32" ? file.toLowerCase() : file;
  const previous = fileTails.get(queueKey) || Promise.resolve();
  const running = previous.then(operation);
  const tail = running.catch(() => {});
  fileTails.set(queueKey, tail);
  void tail.then(() => { if (fileTails.get(queueKey) === tail) fileTails.delete(queueKey); });
  return running;
}

async function readStore(file) {
  let raw;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return { version: 1, entries: {} }; throw error; }
  let store;
  try { store = JSON.parse(raw); }
  catch (error) { throw failure("POOL_UPLOAD_INTENTS_INVALID", "上传意图文件损坏，保留原文件等待恢复"); }
  if (!plain(store) || store.version !== 1 || !plain(store.entries)) throw failure("POOL_UPLOAD_INTENTS_INVALID", "上传意图文件结构错误");
  for (const [scope, entry] of Object.entries(store.entries)) {
    if (!/^[a-f0-9]{64}$/.test(scope) || !plain(entry) || !uuid(entry.id) ||
        typeof entry.key !== "string" || !/^helper-upload-v1-[a-f0-9]{40}$/.test(entry.key) ||
        !["pending", "confirmed"].includes(entry.state) || !Array.isArray(entry.remoteIds) ||
        typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt))) {
      throw failure("POOL_UPLOAD_INTENTS_INVALID", "上传意图记录结构错误");
    }
    if (emailValue(entry.email) !== entry.email || accountEmail(accountValue(entry.account)) !== entry.email) {
      throw failure("POOL_UPLOAD_INTENTS_INVALID", "上传意图邮箱不一致");
    }
    if (entry.state === "pending" && entry.remoteIds.length) throw failure("POOL_UPLOAD_INTENTS_INVALID", "待确认意图含远端 ID");
    if (entry.state === "confirmed") idsValue(entry.remoteIds);
  }
  return store;
}

function result(entry, current, existingIds = []) {
  return {
    id: entry.id,
    key: entry.key,
    account: jsonValue(entry.account),
    existingIds: [...existingIds],
    payloadChanged: JSON.stringify(jsonValue(entry.account)) !== JSON.stringify(current),
  };
}

export class PoolUploadIntents {
  constructor({ filePath } = {}) {
    if (typeof filePath !== "string" || !filePath.trim()) throw failure("POOL_UPLOAD_INTENTS_PATH_INVALID", "缺少上传意图文件路径");
    this.filePath = path.resolve(filePath);
  }

  async prepare(config, value, { lookupAccount } = {}) {
    const origin = backend(config), account = accountValue(value), email = accountEmail(account), scope = scopeFor(origin, email);
    return serialized(this.filePath, async () => {
      const store = await readStore(this.filePath), existing = store.entries[scope];
      if (existing?.state === "pending") return result(existing, account);
      if (existing?.state === "confirmed") {
        if (typeof lookupAccount !== "function") throw failure("POOL_UPLOAD_LOOKUP_REQUIRED", "重新上传前需要确认远端账号是否存在");
        const existingIds = [];
        let lookupError;
        for (const id of existing.remoteIds) {
          let remote;
          try { remote = await lookupAccount(id); }
          catch (error) {
            if (error?.status === 404 || error?.statusCode === 404 || error?.response?.status === 404) remote = null;
            else { lookupError ||= error; continue; }
          }
          if (remote === null) continue;
          if (!plain(remote)) {
            lookupError ||= failure("POOL_UPLOAD_LOOKUP_INVALID", "远端查询必须返回账号对象或明确不存在");
            continue;
          }
          existingIds.push(id);
        }
        if (existingIds.length) return result(existing, account, existingIds);
        if (lookupError) throw lookupError;
      }
      const id = crypto.randomUUID();
      const entry = {
        id,
        key: poolUploadIdempotencyKey({ baseUrl: origin }, [account], id),
        email,
        account,
        state: "pending",
        remoteIds: [],
        createdAt: new Date().toISOString(),
      };
      store.entries[scope] = entry;
      // The exact body and key are durable before the caller may issue POST.
      await writePrivateJsonAtomic(this.filePath, store);
      return result(entry, account);
    });
  }

  async confirm(config, email, intentId, ids) {
    const scope = scopeFor(backend(config), emailValue(email)), remoteIds = idsValue(ids);
    if (!uuid(intentId)) throw failure("POOL_UPLOAD_INTENT_INVALID", "上传意图标识格式错误");
    return serialized(this.filePath, async () => {
      const store = await readStore(this.filePath), entry = store.entries[scope];
      if (!entry || entry.id !== intentId) throw failure("POOL_UPLOAD_INTENT_STALE", "上传意图已变化，保留现有记录");
      entry.state = "confirmed";
      entry.remoteIds = [...new Set([...entry.remoteIds, ...remoteIds])];
      entry.confirmedAt = new Date().toISOString();
      await writePrivateJsonAtomic(this.filePath, store);
      return result(entry, jsonValue(entry.account), entry.remoteIds);
    });
  }

  async observeExisting(config, value, ids) {
    const origin = backend(config), account = accountValue(value), email = accountEmail(account);
    const scope = scopeFor(origin, email), remoteIds = idsValue(ids);
    return serialized(this.filePath, async () => {
      const store = await readStore(this.filePath);
      let entry = store.entries[scope];
      if (!entry) {
        const id = crypto.randomUUID();
        entry = {
          id,
          key: poolUploadIdempotencyKey({ baseUrl: origin }, [account], id),
          email,
          account,
          state: "confirmed",
          remoteIds: [],
          createdAt: new Date().toISOString(),
        };
        store.entries[scope] = entry;
      }
      // A fresh listing can discover a successful POST whose response was lost.
      // Confirm that pending generation without changing its body/key, so a
      // later deletion of all observed rows will create a fresh generation.
      entry.state = "confirmed";
      entry.remoteIds = [...new Set([...entry.remoteIds, ...remoteIds])];
      entry.confirmedAt = new Date().toISOString();
      await writePrivateJsonAtomic(this.filePath, store);
      return result(entry, account, entry.remoteIds);
    });
  }

  async forgetEmail(value) {
    const email = emailValue(value);
    return serialized(this.filePath, async () => {
      const store = await readStore(this.filePath);
      const scopes = Object.keys(store.entries).filter(scope => store.entries[scope].email === email);
      for (const scope of scopes) delete store.entries[scope];
      if (scopes.length) await writePrivateJsonAtomic(this.filePath, store);
      return scopes.length;
    });
  }
}
