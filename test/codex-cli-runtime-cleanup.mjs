import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const baseline = process.argv.includes("--baseline");
const childProcess = createRequire(import.meta.url)("node:child_process");
const originalSpawn = childProcess.spawn, originalSpawnSync = childProcess.spawnSync;
const id = "a".repeat(64);
let queries = 0, removes = 0, syncRemoves = 0;
const handlersBefore = Object.fromEntries(["exit", "SIGTERM", "SIGINT"].map(name => [name, new Set(process.listeners(name))]));
childProcess.spawn = (command, args) => {
  assert.equal(command, "docker");
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.emit("close", 0); return true; };
  const reply = (body, code = 0) => {
    queueMicrotask(() => { child.stdout.end(body); child.stderr.end(); child.emit("close", code); });
  };
  if (args[0] === "start") {
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const message = JSON.parse(String(chunk));
      if (message.method === "initialize") queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id,
        result: { userAgent: "codex_cli_rs/0.165.0 fixture" } }) + "\n"));
      done();
    } });
  } else {
    child.stdin = new PassThrough();
    if (args[0] === "create") reply(id);
    else if (args[0] === "rm") { removes++; reply("", 1); }
    else if (args[0] === "ps") { queries++; reply(queries === 1 ? id + "\n" : ""); }
    else throw new Error("Unexpected Docker command");
  }
  return child;
};
childProcess.spawnSync = (command, args) => {
  assert.equal(command, "docker"); assert.deepEqual(args, ["rm", "--force", id]); syncRemoves++;
  return { status: 0 };
};
syncBuiltinESMExports();

try {
  const moduleUrl = process.env.CODEX_CLI_RUNTIME_PATH
    ? pathToFileURL(process.env.CODEX_CLI_RUNTIME_PATH).href : new URL("../src/codex-cli-runtime.mjs", import.meta.url).href;
  const { openCliSession, waitForContainerRemoval } = await import(moduleUrl);
  const session = await openCliSession({ container: "fixture-container", hostname: "fixture-host" });
  if (baseline) {
    await assert.rejects(session.close(), /临时授权容器尚未清理/);
    assert.equal(queries, 1); assert.equal(removes, 1);
    console.log("BASELINE_CLI_CLEANUP_RACE_REPRODUCED close_rejected=true removal_queries=1 container_absent_on_next_query=true");
    process.exitCode = 1;
  } else {
    await session.close();
    assert.equal(queries, 2, "actual close must wait past the first stale Docker listing");
    assert.equal(removes, 1); assert.equal(syncRemoves, 0);
    await session.close(); assert.equal(queries, 2, "confirmed close is idempotent");
    for (const name of ["exit", "SIGTERM", "SIGINT"]) {
      assert.deepEqual(new Set(process.listeners(name)), handlersBefore[name], "confirmed cleanup leaves no process handlers");
    }

    let calls = 0;
    await waitForContainerRemoval("fixture-container", {
      timeoutMs: 100, pollMs: 1,
      run: async (args, options) => {
        assert.deepEqual(args, ["ps", "--all", "--quiet", "--filter", "id=fixture-container"]);
        assert(options.timeout > 0 && options.timeout <= 100, "Docker query shares the cleanup deadline");
        return ++calls < 3 ? "fixture-container\n" : "";
      },
    });
    assert.equal(calls, 3);
    let transientErrors = 0;
    await waitForContainerRemoval("fixture-transient", {
      timeoutMs: 100, pollMs: 1,
      run: async () => { if (++transientErrors < 3) throw new Error("daemon is processing rm"); return ""; },
    });
    assert.equal(transientErrors, 3);
    await assert.rejects(waitForContainerRemoval("fixture-stuck", {
      timeoutMs: 8, pollMs: 1, run: async () => "fixture-stuck\n",
    }), /临时授权容器尚未清理/);
    await assert.rejects(waitForContainerRemoval("fixture-offline", {
      timeoutMs: 8, pollMs: 1, run: async () => { throw new Error("fixture-private-daemon-error"); },
    }), error => /临时授权容器尚未清理/.test(error.message) && !error.message.includes("fixture-private-daemon-error"));
    console.log("CODEX_CLI_CLEANUP_PASS actual_close_race=true poll_until_absent=true transient_errors_retried=true timeout_reported=true daemon_failure_not_success=true shared_deadline=true idempotent=true");
  }
} finally {
  for (const name of ["exit", "SIGTERM", "SIGINT"]) {
    for (const listener of process.listeners(name)) if (!handlersBefore[name].has(listener)) process.off(name, listener);
  }
  childProcess.spawn = originalSpawn; childProcess.spawnSync = originalSpawnSync; syncBuiltinESMExports();
}
