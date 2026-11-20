import assert from "node:assert/strict";
import {
  createChatCatalog,
  parseSyncedAccountModels,
} from "../src/chat-upstream-catalog.mjs";
import { drainRequestKind } from "../src/release-drain.mjs";

let tick = 1,
  rejectSync = false,
  waitForNext,
  revision = 0;
const calls = [];
const native = [
  "native-only",
  "codex-auto-review",
  "gpt-reserve",
  "vendor/image-preview",
];
const catalog = createChatCatalog({
  identity: (c) => c.site,
  now: () => tick,
  ttl: 30,
  request: async (c, path, options) => {
    calls.push({ c, path, options });
    assert.match(
      path,
      /^\/api\/v1\/admin\/accounts\/[1-9]\d*\/models\/sync-upstream$/,
    );
    assert.equal(options.method, "POST");
    assert.deepEqual(JSON.parse(options.body), {});
    assert.equal(options.headers, undefined);
    if (waitForNext) await waitForNext;
    if (rejectSync)
      throw Object.assign(Error("upstream secret should not be echoed"), {
        remoteStatus: 403,
      });
    return {
      code: 0,
      data: {
        models: [...native, c.site + "-" + path.split("/")[5] + "-" + revision],
        metadata: {
          "not-listed": { display_name: "should not become a model" },
        },
        warnings: [],
      },
    };
  },
});
const target = { c: { site: "pool-a" }, account: "a", id: "7" };
let release;
waitForNext = new Promise((resolve) => {
  release = resolve;
});
const p = catalog(target),
  p2 = catalog(target, { fresh: true });
release();
const [a, b] = await Promise.all([p, p2]);
waitForNext = null;
assert.deepEqual(a, b);
assert.deepEqual(a, { models: [...native, "pool-a-7-0"], hasWarnings: false });
assert.equal(calls.length, 1);
revision++;
assert.deepEqual(await catalog(target), a);
assert.notDeepEqual(await catalog({ ...target, id: "8" }), a);
assert.notDeepEqual(await catalog({ ...target, c: { site: "pool-b" } }), a);
await catalog({ ...target, account: "b" });
assert.equal(calls.length, 4);
tick += 31;
assert.deepEqual((await catalog(target)).models, [...native, "pool-a-7-1"]);
revision++;
assert.deepEqual((await catalog(target, { fresh: true })).models, [
  ...native,
  "pool-a-7-2",
]);
rejectSync = true;
for (const fresh of [true, false])
  await assert.rejects(
    catalog(target, { fresh }),
    (e) =>
      e.status === 502 &&
      e.message.includes("403") &&
      !e.message.includes("secret"),
  );
assert.equal(
  calls.length,
  8,
  "no stale cache, retries, or alternative endpoint on failure",
);
for (const id of ["", "1/2", "0", "8?x=1"])
  await assert.rejects(catalog({ ...target, id }), { status: 400 });
assert.equal(calls.length, 8);
assert.deepEqual(
  parseSyncedAccountModels({
    code: 0,
    data: { models: [], warnings: [{ code: "incomplete" }] },
  }),
  { models: [], hasWarnings: true },
);
assert.deepEqual(
  parseSyncedAccountModels({ code: 0, data: { models: ["valid", "valid"] } })
    .models,
  ["valid"],
);
for (const x of [
  null,
  { data: [] },
  { code: 1, data: { models: ["no"] } },
  { data: { metadata: { foo: {} } } },
  { data: { models: [{ id: "mapping" }] } },
  { data: { models: ["a\nb"] } },
]) {
  assert.throws(() => parseSyncedAccountModels(x), { status: 502 });
}
assert.equal(drainRequestKind("GET", "/api/jobs/aaaa/chat/models"), "new");
assert.equal(drainRequestKind("GET", "/api/jobs/aaaa/chat"), "read");
console.log(
  "ACCOUNT_SYNC_PASS native ID endpoint, exact ordered list, per-account caching, empty/warnings/errors, maintenance guard",
);
