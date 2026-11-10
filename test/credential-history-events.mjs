import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recordWorkspaceHistory, recordAcceptedPhone, phoneOrderDetails } from "../src/credential-events.mjs";
import { readCredentialHistory, writePrivateJsonAtomic } from "../src/account-history.mjs";
import { readAccountLogEntries } from "../src/account-log-entries.mjs";
import { identifyWebPlan } from "../src/protocol-login.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "helper-history-events-"));
const job = { email: "fixture@example.test", outputPath: path.join(root, "sub2api-import-oauth.json") };
const personal = { id: "personal", name: "Personal", structure: "personal", plan_type: "free" };
const team = { id: "team", name: "Team", structure: "workspace", plan_type: "business_premium" };
const records = async type => (await readCredentialHistory(root)).filter(event => event.type === type);
try {
  for (const data of [{}, { accounts: null }, { accounts: [personal, null] }, { accounts: [{ nope: true }] }, { accounts: [personal], has_more: true }, { accounts: {}, error: "provider error" }]) {
    assert.equal(await recordWorkspaceHistory(root, data, job.email), null);
  }
  const first = await recordWorkspaceHistory(root, { accounts: [personal, team] }, job.email);
  assert.equal(first.stage, "discovered"); assert.equal(first.changes.added.length, 2);
  await Promise.all(Array.from({ length: 8 }, () => recordWorkspaceHistory(root, { accounts: [team, personal], current_account_id: "team" }, job.email)));
  assert.equal((await records("workspaces")).length, 1, "order/selection and concurrent probes must not duplicate history");
  const changed = await recordWorkspaceHistory(root, { accounts: [personal, { ...team, plan_type: "free", is_deactivated: true, error: { code: "deactivated_workspace" } }] }, job.email);
  assert.equal(changed.changes.updated.length, 1);
  assert.equal(changed.changes.updated[0].after.availabilityCode, "deactivated_workspace");
  assert.equal(changed.changes.updated[0].after.deactivated, true);
  const removed = await recordWorkspaceHistory(root, { accounts: [personal] }, job.email);
  assert.equal(removed.changes.removed[0].id, "team");
  await recordWorkspaceHistory(root, { accounts: [] }, job.email);
  await recordWorkspaceHistory(root, { accounts: [personal] }, job.email);
  assert.equal((await records("workspaces")).length, 5, "returning to an old state must be retained");
  // A fresh call reads the committed history rather than an in-memory baseline.
  assert.equal(await recordWorkspaceHistory(root, { accounts: { alias: { account: { ...personal, account_id: personal.id } } } }, job.email), null);
  const protocolRoot = path.join(root, "protocol");
  const client = { async getJson(method, url) { return { data: url.endsWith("/api/auth/session") ? { accessToken: "opaque" } : { accounts: [personal] } }; } };
  await identifyWebPlan(client, { chatgptBase: "http://fixture", historyRoot: protocolRoot, email: job.email });
  assert.equal((await readCredentialHistory(protocolRoot)).filter(event => event.type === "workspaces").length, 1, "first Web login must capture discovery");

  assert.equal((await records("phone")).length, 0, "acquired/received-only orders must not be credentials");
  const order = { ...phoneOrderDetails({ requestId: "paid-1", number: "+12025550111", country: "1", countryName: "USA", providerId: "123", rank: "gold", cost: { amount: "0.35", currency: "840" }, apiKey: "do-not-copy" }, "smsbower", "SMSBower"), runId: "run-1" };
  await writePrivateJsonAtomic(path.join(root, "sms-order.json"), order);
  await Promise.all(Array.from({ length: 6 }, () => recordAcceptedPhone(root, { phone: order.number, email: job.email, runId: "run-1" })));
  let phones = await records("phone"); assert.equal(phones.length, 1);
  assert.equal(phones[0].after.phone, order.number); assert.equal(phones[0].after.countryName, "USA");
  assert.deepEqual(phones[0].after.cost, { amount: "0.35", currency: "USD" });
  assert.equal(phones[0].after.supplierId, "123"); assert(!JSON.stringify(phones).includes("do-not-copy"));
  await recordAcceptedPhone(root, { phone: "+12025550222", email: job.email, runId: "run-2" });
  phones = await records("phone"); assert.equal(phones.length, 2);
  assert.equal(phones.find(event => event.after.phone.endsWith("222")).after.providerName, "手动号码", "unrelated order must not be attributed");
  assert.equal(await recordAcceptedPhone(root, { phone: "not-phone", runId: "run-3" }), null);
  const list = await readAccountLogEntries(job, { view: "credentials" });
  assert.equal(list.entries.filter(e => e.type === "workspaces").length, 5);
  assert(!JSON.stringify(list.entries).includes("+1202555"), "phone details must stay lazy-loaded");
  assert.equal(JSON.parse((await readAccountLogEntries(job, { view: "credentials", entryId: phones[0].id })).content).type, "phone");
  console.log("CREDENTIAL_EVENTS_PASS workspace discovery/add/remove/plan/deactivation, unchanged/reordered/concurrent/restarted probes; successful phones only, idempotent private country/cost records and lazy details");
} finally { await fs.rm(root, { recursive: true, force: true }); }
