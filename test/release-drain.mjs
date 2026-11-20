import assert from "node:assert/strict";
import { releaseDispatchPaused, drainRequestKind } from "../src/release-drain.mjs";
const marker = "fixture", pid = "123", ticks = "456";
const stat = start => pid + " (worker ) name) S " + Array(18).fill(0).concat(start).join(" ");
const probe = (owner, processStat) => releaseDispatchPaused({
  marker, exists: () => owner !== null,
  read: name => { if (name === marker) return owner;
    assert.equal(name, "/proc/123/stat");
    if (!processStat) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return processStat;
  },
});
assert.equal(probe(null), false);
assert.equal(probe("123 456", stat(ticks)), true);
assert.equal(probe("123 456", stat("789")), false); // PID reused
assert.equal(probe("123 456", null), false); // installer killed
assert.equal(probe("bad marker", null), true);
assert.equal(drainRequestKind("POST", "/api/jobs/a-b-c/input"), "finish");
assert.equal(drainRequestKind("POST", "/api/jobs/query"), "read");
assert.equal(drainRequestKind("POST", "/api/jobs"), "new");
