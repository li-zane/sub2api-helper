import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountLoginEmails, normalizeLoginEmail } from "../src/account-login-email.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-login-emails-"));
const file = path.join(root, "emails.json"), store = new AccountLoginEmails(file);
try {
  await store.load();
  assert.equal(normalizeLoginEmail(" Login+tag@Example.TEST "), "login+tag@example.test");
  for (const email of [null, 12, "", "bad", "a@b", "a\nb@example.test", "a----b@example.test", "a".repeat(255) + "@example.test"]) {
    assert.throws(() => normalizeLoginEmail(email), e => e.status === 400);
  }
  assert.equal(store.email("first@example.test"), "first@example.test");
  assert.equal(await store.update("first@example.test", "FIRST@example.test"), false);
  await assert.rejects(fs.access(file), { code: "ENOENT" });
  assert.equal(await store.update("first@example.test", "next@example.test", { expectedEmail: "first@example.test" }), true);
  assert.equal(store.key("NEXT@example.test"), "first@example.test");
  assert.equal(store.email("first@example.test"), "next@example.test");
  const change = store.history("next@example.test")[0];
  assert.deepEqual(change.before, { email: "first@example.test" });
  assert.deepEqual(change.after, { email: "next@example.test" });
  assert(Number.isFinite(Date.parse(change.at)));
  change.after.email = "mutated@example.test";
  assert.equal(store.history("first@example.test")[0].after.email, "next@example.test");
  await assert.rejects(store.update("first@example.test", "third@example.test", { expectedEmail: "first@example.test" }), e => e.status === 409);
  await assert.rejects(store.update("other@example.test", "next@example.test"), e => e.status === 409);
  await assert.rejects(store.update("first@example.test", "occupied@example.test", { assertAvailable: () => { throw Error("occupied"); } }), /occupied/);
  const before = await fs.readFile(file, "utf8");
  await fs.writeFile(path.join(root, "blocked"), "fixture"); store.file = path.join(root, "blocked", "emails.json");
  await assert.rejects(store.update("first@example.test", "uncommitted@example.test"));
  assert.equal(store.email("first@example.test"), "next@example.test");
  assert.equal(await fs.readFile(file, "utf8"), before);
  store.file = file;
  const concurrent = await Promise.allSettled([
    store.update("first@example.test", "third@example.test", { expectedEmail: "next@example.test" }),
    store.update("first@example.test", "fourth@example.test", { expectedEmail: "next@example.test" }),
  ]);
  assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(concurrent[1].reason.status, 409);
  const restored = new AccountLoginEmails(file); await restored.load();
  assert.equal(restored.email("next@example.test"), "third@example.test");
  assert.deepEqual(restored.emails("first@example.test"), ["first@example.test", "third@example.test", "next@example.test"]);
  assert.equal(restored.history("third@example.test").length, 2);
  await restored.update("first@example.test", "first@example.test");
  assert.equal(restored.history("first@example.test").length, 3, "reverting email deleted history");
  await restored.remove("third@example.test");
  const deleted = new AccountLoginEmails(file); await deleted.load();
  assert.equal(deleted.history("first@example.test").length, 0);
  assert.equal(deleted.key("third@example.test"), "third@example.test");
  console.log("LOGIN_EMAIL_STORE_PASS validation; atomic email+history; alias collision; stale/concurrent saves; disk failure; restart; revert; delete");
} finally { await fs.rm(root, { recursive: true, force: true }); }
