import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createInterface } from "node:readline";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-workers-test-"));
const stateRoot = path.join(root, "state"), worker = path.join(root, "worker.mjs");
const docker = args => promisify(execFile)("docker", args, { windowsHide: true, timeout: 30_000 });
const workers = [], environments = [];
let gatewayUA = "before", puts = 0;
const pool = http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  assert.equal(req.headers["x-api-key"], "fixture");
  if (req.method === "PUT") {
    const next = JSON.parse(body);
    assert.equal(next.registration_enabled, true);
    gatewayUA = next.openai_codex_user_agent; puts++;
  }
  await new Promise(resolve => setTimeout(resolve, 40));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ code: 0, data: { openai_codex_user_agent: gatewayUA, registration_enabled: true } }));
});
await new Promise(resolve => pool.listen(0, "127.0.0.1", resolve));
const gateway = { baseUrl: `http://127.0.0.1:${pool.address().port}`, adminApiKey: "fixture" };
await fs.writeFile(worker, `
  import {runCliOAuth,syncCliUserAgent,validateCliAuthUrl} from ${JSON.stringify(new URL("../src/codex-cli-oauth.mjs", import.meta.url).href)};
  import {openCliSession} from ${JSON.stringify(new URL("../src/codex-cli-runtime.mjs", import.meta.url).href)};
  const [mode,email]=process.argv.slice(2); const root=${JSON.stringify(stateRoot)}, gateway=${JSON.stringify(gateway)};
  console.log(JSON.stringify({event:'started'}));
  if(mode==='sync') {
    await syncCliUserAgent(gateway,email,{root}); console.log(JSON.stringify({event:'done'}));
  } else {
    let environment,session;
    try { await runCliOAuth({root,expectedEmail:email,gateway,
      openSession:async(profile,options)=>{environment=profile;return session=await openCliSession(profile,options)},
      authorize:async(authUrl)=>{
        const link=validateCliAuthUrl(authUrl);const account=await session.request('account/read',{});
        if(account.account!==null)throw Error('new environment is logged in');
        console.log(JSON.stringify({event:'ready',environment,state:link.state,userAgent:session.userAgent}));
        await new Promise(resolve=>process.stdin.once('data',resolve));throw Error('FIXTURE_CANCEL');
      }});
    } catch(error) {if(error.message!=='FIXTURE_CANCEL')throw error;}
    finally {process.stdin.destroy();}
    console.log(JSON.stringify({event:'done'}));
  }
`);

function start(email, mode = "login") {
  const child = spawn(process.execPath, [worker, mode, email], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const events = new Map(), waiters = new Map();
  const lines = createInterface({ input: child.stdout });
  const ended = new Promise(resolve => child.once("exit", code => { lines.close(); resolve(code); }));
  lines.on("line", line => {
    const value = JSON.parse(line); events.set(value.event, value);
    if (value.environment) environments.push(value.environment);
    for (const resolve of waiters.get(value.event) || []) resolve(value);
    waiters.delete(value.event);
  });
  const state = { child, events, ended, async wait(name) {
    if (events.has(name)) return events.get(name);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker ${name} timeout: ${stderr}`)), 30_000);
      if (!waiters.has(name)) waiters.set(name, new Set());
      waiters.get(name).add(value => { clearTimeout(timer); resolve(value); });
      ended.then(code => { clearTimeout(timer); if (!events.has(name)) reject(new Error(`worker exited ${code}: ${stderr}`)); else resolve(events.get(name)); });
    });
  }, async cancel() { child.stdin.end("cancel\n"); assert.equal(await ended, 0, stderr); } };
  workers.push(state); return state;
}

async function assertGone(environment) {
  for (const deadline = Date.now() + 15_000; ; ) {
    const listing = await docker(["ps", "--all", "--quiet", "--filter", `name=^/${environment.container}$`]);
    if (!listing.stdout.trim()) return;
    if (Date.now() >= deadline) throw new Error("temporary container remained after worker exit");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

try {
  const group = [start("first@example.invalid"), start("second@example.invalid"), start("third@example.invalid")];
  const ready = await Promise.all(group.map(w => w.wait("ready")));
  assert.equal(new Set(ready.map(r => r.environment.runId)).size, 3);
  assert.equal(new Set(ready.map(r => r.state)).size, 3, "parallel CLI sessions own separate PKCE/state");
  assert.equal(new Set(ready.map(r => r.userAgent)).size, 1);
  const userAgent = ready[0].userAgent;
  assert.match(userAgent, /^codex_cli_rs\/0\.165\.0 /);
  for (const { environment } of ready) {
    const description = JSON.parse((await docker(["inspect", environment.container])).stdout)[0];
    assert.deepEqual(description.HostConfig.PortBindings, {});
    assert.equal(description.HostConfig.ReadonlyRootfs, true);
    assert.equal(description.Config.User, "1000:1000");
    assert.equal(description.Config.Hostname, environment.hostname);
    assert(description.HostConfig.Tmpfs["/home/node/.codex"].includes("mode=0700"));
    assert(!description.Mounts.some(mount => mount.Type === "volume" || mount.Type === "bind"));
  }
  await docker(["exec", ready[0].environment.container, "node", "-e", "require('node:fs').writeFileSync('/home/node/.codex/test-marker','first')"]);
  for (const { environment } of ready.slice(1)) {
    assert.equal((await docker(["exec", environment.container, "node", "-e", "console.log(require('node:fs').existsSync('/home/node/.codex/test-marker'))"])).stdout.trim(), "false");
  }
  // The same account waits for its prior worker; other accounts stay active.
  const same = start("first@example.invalid"); await same.wait("started");
  await new Promise(resolve => setTimeout(resolve, 250));
  assert(!same.events.has("ready"));
  await group[0].cancel(); await assertGone(ready[0].environment);
  const repeated = await same.wait("ready");
  assert.notEqual(repeated.environment.runId, ready[0].environment.runId);
  assert.equal((await docker(["exec", repeated.environment.container, "node", "-e", "console.log(require('node:fs').existsSync('/home/node/.codex/test-marker'))"])).stdout.trim(), "false");
  await same.cancel(); await assertGone(repeated.environment);

  // Hard termination on Windows bypasses JS finally; stdin EOF still ends the
  // CLI and --rm removes the tmpfs container. The next run reclaims its lock.
  group[1].child.kill("SIGTERM"); await group[1].ended; await assertGone(ready[1].environment);
  assert.equal(JSON.parse((await docker(["inspect", ready[2].environment.container])).stdout)[0].State.Running, true);
  const retries = [start("second@example.invalid"), start("second@example.invalid"), start("second@example.invalid")];
  const remaining = new Set(retries);
  while (remaining.size) {
    const winner = await Promise.race([...remaining].map(async w => ({ worker: w, result: await w.wait("ready") })));
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal([...remaining].filter(w => w.events.has("ready")).length, 1, "only one worker may reclaim the dead owner's lock");
    remaining.delete(winner.worker);
    await winner.worker.cancel(); await assertGone(winner.result.environment);
  }
  await group[2].cancel(); await assertGone(ready[2].environment);

  const syncing = [start(userAgent, "sync"), start(userAgent, "sync"), start(userAgent, "sync")];
  for (const w of syncing) assert.equal(await w.ended, 0);
  assert.equal(puts, 1, "separate workers serialize the global UA update and skip identical writes");
  assert.equal(gatewayUA, userAgent);
  const db = new DatabaseSync(path.join(stateRoot, "codex-cli-locks.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM cli_locks").get().n, 0); db.close();
  assert.deepEqual((await fs.readdir(stateRoot)).sort(), ["codex-cli-locks.sqlite", "gateway-ua-last-sync.json"], "only coordination and UA audit data remain");
  console.log("CODEX_CLI_DOCKER_PASS 3 parallel workers, isolated tmpfs/callbacks, atomic same-account locking, 3 crash-retry contenders, cleanup, 1 UA write, no persistent volumes");
} finally {
  for (const w of workers) if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill();
  await Promise.all(workers.map(w => w.ended));
  for (const environment of environments) await docker(["rm", "--force", environment.container]).catch(() => {});
  pool.closeAllConnections(); await new Promise(resolve => pool.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
