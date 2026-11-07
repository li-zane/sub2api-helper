import assert from "node:assert/strict";
import { groupCredentialHistory } from "../web/src/credential-history-groups.mjs";

const entries = [
  { id: "p-old", type: "password", at: "2026-11-01T00:00:00Z" },
  { id: "2fa-old", type: "2fa", at: "2026-11-02T00:00:00Z" },
  { id: "p-current", type: "password", stage: "current", at: "2026-11-03T00:00:00Z" },
  { id: "p-new", type: "password", stage: "submission_pending", at: "2026-11-07T00:00:00Z" },
  { id: "2fa-new", type: "2fa", at: "2026-11-06T00:00:00Z" },
  { id: "web", type: "web_session", at: "2026-11-05T00:00:00Z" },
  { id: "unknown-date", type: "password", at: "invalid" },
  { id: "no-date", type: "password", at: null },
];
const before = JSON.stringify(entries), groups = groupCredentialHistory(entries);
assert.deepEqual(groups.map(g => g.type), ["password", "2fa", "web_session"]);
assert.equal(groups[0].latest.id, "p-new", "current aliases must not override chronological order");
assert.deepEqual(groups[0].history.map(e => e.id), ["p-current", "p-old", "unknown-date", "no-date"]);
assert.deepEqual(groups[1].history.map(e => e.id), ["2fa-old"]);
assert.deepEqual(groups[2].history, []);
assert.equal(JSON.stringify(entries), before, "input mutated");
assert.equal(groups[0].latest, entries[3], "original entry IDs/metadata must remain intact");
const sameTime = groupCredentialHistory([{id:"a",type:"password",at:"2026-01-01"},{id:"b",type:"password",at:"2026-01-01"}]);
assert.equal(sameTime[0].latest.id,"a");assert.equal(sameTime[0].history[0].id,"b");
const offsets=groupCredentialHistory([{id:"local",type:"password",at:"2026-11-07T03:30:00+08:00"},{id:"utc",type:"password",at:"2026-11-06T20:00:00Z"}]);
assert.equal(offsets[0].latest.id,"utc");
const unknown=groupCredentialHistory([{id:"u",type:"__proto__",at:null},{id:"v",type:"__proto__",at:false},{id:"w",at:""}]);
assert.equal(unknown.length,2);assert.equal(unknown[0].history.length,1);assert.equal(unknown[1].type,"unknown");
assert.deepEqual(groupCredentialHistory(),[]);
console.log("CREDENTIAL_HISTORY_GROUPS_PASS type grouping; newest-first groups/versions; stable ties; invalid dates last; offsets; no mutation; raw IDs preserved");
