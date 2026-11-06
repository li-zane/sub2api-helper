import crypto from "node:crypto";

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("POOL_UPLOAD_EMAIL_INVALID: 上传账号缺少有效邮箱");
  return email;
}

function backend(config) {
  const url = new URL(String(config?.baseUrl || ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("POOL_UPLOAD_BACKEND_INVALID: 号池地址格式错误");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function serializable(value) {
  return canonical(JSON.parse(JSON.stringify(value)));
}

const accountEmail = account => account?.credentials?.email || account?.extra?.email || account?.email;

// One instance must be shared by manual uploads, automatic pipelines and pool
// recovery. Hold the lock across the fresh listing AND every create/update.
// API-key changes must not split a backend's lock domain.
export class PoolUploadLocks {
  constructor() { this.tails = new Map(); }

  async run(config, emails, operation) {
    if (!Array.isArray(emails) || !emails.length || typeof operation !== "function") throw new Error("POOL_UPLOAD_LOCK_INVALID: 缺少账号或上传操作");
    const origin = backend(config);
    const keys = [...new Set(emails.map(normalizeEmail))].sort().map(email => `${origin}\0${email}`);
    const release = [];
    try {
      // Global ordering also handles overlapping bulk uploads without deadlock.
      for (const key of keys) release.push(await this.acquire(key));
      return await operation();
    } finally {
      for (const unlock of release.reverse()) unlock();
    }
  }

  async acquire(key) {
    let unlock;
    const held = new Promise(resolve => { unlock = resolve; });
    const previous = this.tails.get(key) || Promise.resolve();
    const tail = previous.then(() => held);
    this.tails.set(key, tail);
    await previous;
    return () => {
      unlock();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }
}

// Identical creation payloads reuse the same key across calls/restarts instead
// of receiving a new random UUID. Credential values are hashed, never emitted.
// A new, durably recorded generation permits recreation after confirmed remote
// deletion. Callers should retain a pending generation when a POST times out.
export function poolUploadIdempotencyKey(config, accounts, generation = "") {
  if (!Array.isArray(accounts) || !accounts.length) throw new Error("POOL_UPLOAD_EMPTY: 没有可上传账号");
  const sorted = accounts.map(account => ({ email: normalizeEmail(accountEmail(account)), data: serializable(account) }))
    .sort((a, b) => a.email.localeCompare(b.email) || JSON.stringify(a.data).localeCompare(JSON.stringify(b.data)));
  const digest = crypto.createHash("sha256").update(JSON.stringify({ backend: backend(config), generation: String(generation), accounts: sorted })).digest("hex");
  // A bounded header with a version prefix and a 160-bit payload digest.
  return `helper-upload-v1-${digest.slice(0, 40)}`;
}

// A single stale listing must not let duplicate local jobs put the same email
// into one batch twice. Conflicting credentials require an explicit winner.
export function uniquePoolUploadAccounts(accounts, getEmail = accountEmail) {
  const unique = new Map();
  for (const account of accounts) {
    const email = normalizeEmail(getEmail(account)), signature = JSON.stringify(serializable(account));
    const previous = unique.get(email);
    if (previous && previous.signature !== signature) throw Object.assign(
      new Error("POOL_UPLOAD_DUPLICATE_EMAIL: 同一上传包含同邮箱的不同凭据，请先选择保留的账号"),
      { status: 409, code: "POOL_UPLOAD_DUPLICATE_EMAIL" },
    );
    if (!previous) unique.set(email, { signature, account });
  }
  return [...unique.values()].map(value => value.account);
}
