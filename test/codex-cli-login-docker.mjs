import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { CODEX_CLI_IMAGE, CODEX_CLI_VERSION, cliContainerArgs, deliverCliCallbackToContainer } from "../src/codex-cli-runtime.mjs";
import { runCliOAuth } from "../src/codex-cli-oauth.mjs";

// The official pinned CLI runs with no network. A local issuer inside the same
// container supplies synthetic tokens so the real callback/server lifecycle is
// exercised without authorizing an account or contacting an external service.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-login-test-"));
const issuer = "http://127.0.0.1:1456", email = "repro@example.invalid";
const jwt = payload => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.fixture`;
const metadata = { chatgpt_plan_type: "plus", chatgpt_account_id: "mock-workspace", chatgpt_user_id: "mock-user" };
const tokens = { access_token: jwt({ exp: 4102444800, "https://api.openai.com/auth": metadata }),
  refresh_token: "mock-refresh-only", id_token: jwt({ email, sub: "mock-user", "https://api.openai.com/auth": metadata }) };
const docker = async (args, input) => {
  const child = promisify(execFile)("docker", args, { windowsHide: true, timeout: 30_000, maxBuffer: 2_000_000 });
  if (input !== undefined) child.child.stdin.end(input);
  return (await child).stdout.trim();
};
let gatewayRequests = 0;
const gateway = http.createServer((req, res) => { gatewayRequests++; res.end("{}"); });
await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
const containers = [];

function mockIssuer(rejectToken) {
  return `const http=require('node:http');http.createServer(async(q,s)=>{
    let b='';for await(const c of q)b+=c;s.setHeader('content-type','application/json');
    if(q.url==='/oauth/token'){
      if(!${rejectToken} && new URLSearchParams(b).get('grant_type')==='authorization_code')s.end(${JSON.stringify(JSON.stringify(tokens))});
      else{s.statusCode=400;s.end(JSON.stringify({error:'invalid_grant',error_description:'mock-private-upstream'}))}
    }else if(q.url.includes('/accounts/check'))s.end(JSON.stringify({accounts:[{id:'mock-workspace',workspace_backend_origin:'https://chatgpt.com',account_routing_override:'NO_CONSTRAINT'}]}));
    else s.end('{}');
  }).listen(1456,'127.0.0.1');`;
}

async function testLogin(rejectToken) {
  const progress = [], completed = new Map(), pending = new Map();
  const exportPath = path.join(root, rejectToken ? "rejected.json" : "export.json");
  let id, child, lines, sequence = 0, cleanup = false, bridge;
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++sequence;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`FIXTURE_RPC_TIMEOUT ${method}`)); }, 15_000);
    pending.set(key, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id: key, method, params })}\n`);
  });
  const close = async () => {
    if (id) {
      await docker(["rm", "--force", id]).catch(() => {});
      assert.equal(await docker(["ps", "--all", "--quiet", "--filter", `id=${id}`]), "");
    }
    child?.kill(); lines?.close();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("FIXTURE_CLOSED")); }
    pending.clear(); cleanup = true;
  };
  try {
    const flow = runCliOAuth({ root, expectedEmail: email, workspaceId: "mock-workspace", authBase: issuer, exportPath,
      gateway: { baseUrl: `http://127.0.0.1:${gateway.address().port}`, adminApiKey: "mock-admin" },
      onProgress: message => progress.push(message),
      authorize: async authUrl => {
        const auth = new URL(authUrl), callback = new URL(auth.searchParams.get("redirect_uri"));
        callback.searchParams.set("code", "mock-private-code"); callback.searchParams.set("state", auth.searchParams.get("state"));
        return { callbackUrl: callback.href };
      },
      openSession: async (profile, options) => {
        const args = cliContainerArgs(profile, options);
        args.splice(args.indexOf(CODEX_CLI_IMAGE), 0, "--network=none", "--env", `CODEX_APP_SERVER_LOGIN_ISSUER=${issuer}`);
        args.splice(args.length - 1, 0, "-c", `chatgpt_base_url=${JSON.stringify(issuer)}`);
        id = await docker(args); containers.push(id);
        const description = JSON.parse(await docker(["inspect", id]))[0];
        assert.equal(description.HostConfig.NetworkMode, "none");
        child = spawn("docker", ["start", "--attach", "--interactive", id], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        child.stderr.resume(); child.stdin.on("error", () => {});
        lines = createInterface({ input: child.stdout });
        lines.on("line", line => {
          let message; try { message = JSON.parse(line); } catch { return; }
          const item = pending.get(message.id);
          if (item) {
            pending.delete(message.id); clearTimeout(item.timer);
            if (message.error) item.reject(new Error("FIXTURE_RPC_ERROR")); else item.resolve(message.result);
          } else if (message.method === "account/login/completed") completed.set(message.params.loginId, message.params);
        });
        const init = await request("initialize", { clientInfo: { name: "codex_cli_rs", version: CODEX_CLI_VERSION } });
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
        assert.equal((await request("account/read", {})).account, null, "new CLI has no saved login");
        await docker(["exec", "--detach", id, "node", "-e", mockIssuer(rejectToken)]);
        await docker(["exec", id, "node", "--input-type=module", "-e", `
          let ready=false;for(let i=0;i<50;i++){try{await fetch('${issuer}/health');ready=true;break}catch{}await new Promise(r=>setTimeout(r,100))}if(!ready)process.exit(1);`]);
        return { userAgent: init.userAgent, request,
          async deliverCallback(value) { bridge = await deliverCliCallbackToContainer(id, value, { onProgress: options.onProgress }); },
          async waitForLogin(loginId) {
            for (const deadline = Date.now() + 10_000; !completed.has(loginId);) {
              if (Date.now() >= deadline) throw new Error("FIXTURE_LOGIN_TIMEOUT");
              await new Promise(resolve => setTimeout(resolve, 30));
            }
            if (!completed.get(loginId).success) throw new Error("FIXTURE_LOGIN_REJECTED");
          },
          async readAuth() { return JSON.parse(await docker(["exec", id, "node", "-e", "process.stdout.write(require('node:fs').readFileSync('/home/node/.codex/auth.json'))"])); },
          async discardAuth() { await request("account/logout", {}); },
          async close() {
            if (!rejectToken) assert.equal(JSON.parse(await fs.readFile(exportPath)).accounts[0].credentials.refresh_token, tokens.refresh_token,
              "converted credentials are exported before container removal");
            await close();
          },
        };
      },
    });
    if (rejectToken) {
      await assert.rejects(flow, /FIXTURE_LOGIN_REJECTED/);
      await assert.rejects(fs.access(exportPath), { code: "ENOENT" });
      assert(progress.some(line => /stage=login_completed failed/.test(line)));
      assert.equal(bridge.callbackStatus, 200, "CLI error pages do not decide authentication success");
    } else {
      const converted = await flow;
      assert.equal(converted.account.credentials.chatgpt_account_id, "mock-workspace");
      assert.equal(converted.account.credentials.email, email);
      assert.equal(converted.account.credentials.access_token, tokens.access_token);
      assert.match(converted.account.extra.codex_cli_user_agent, /^codex_cli_rs\/0\.165\.0 /);
      assert.equal(bridge.callbackStatus, 302); assert.equal(bridge.successStatus, 200);
      assert.equal(bridge.followedSuccess, true);
      assert.equal(completed.size, 1); assert.equal([...completed.values()][0].success, true);
    }
    assert(cleanup); assert(progress.some(line => /stage=cleanup ok/.test(line)));
    assert.equal(new Set(progress.map(line => line.match(/^\[env=([\da-f-]{36})\]/)?.[1])).size, 1);
    assert(!/mock-private|mock-refresh|e30\.|[?&](code|state|id_token)=/.test(progress.join("\n")));
    assert.equal(gatewayRequests, 0);
    console.log(rejectToken
      ? "CLI_LOGIN_REJECTED_PASS callback=200 completion=false export=false cleanup=true gatewayRequests=0"
      : "CLI_LOGIN_PASS callback=302 success=200 completion=true export=true cleanup=true gatewayRequests=0");
  } finally { if (!cleanup) await close(); }
}

try {
  await testLogin(false);
  await testLogin(true);
  for (const id of containers) assert.equal(await docker(["ps", "--all", "--quiet", "--filter", `id=${id}`]), "");
  console.log("CLI_LOGIN_DOCKER_PASS image=0.165.0 network=none syntheticTokens=true remaining=0");
} finally {
  gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
