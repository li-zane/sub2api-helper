import path from "node:path";
import { cliProfile, openCliSession, CODEX_CLI_VERSION } from "../../src/codex-cli-runtime.mjs";

// Deployment readiness probe only: no account credentials, token exchange,
// gateway requests, model inference or exported auth files.
const root = path.resolve(process.env.TOSUB2_CLI_PROFILE_ROOT || ".tmp/codex-cli-check");
const profile = await cliProfile(root, "readiness@example.invalid");
const session = await openCliSession(profile);
let userAgent;
try {
  const current = await session.request("account/read", { refreshToken: false });
  if (current.account !== null) throw new Error("CLI readiness requires an empty environment");
  const login = await session.request("account/login/start", { type: "chatgpt", codexStreamlinedLogin: true });
  const url = new URL(login.authUrl);
  if (login.type !== "chatgpt" || !login.loginId || url.origin !== "https://auth.openai.com" || url.pathname !== "/oauth/authorize") {
    throw new Error("CLI did not generate the expected authorization URL");
  }
  await session.request("account/login/cancel", { loginId: login.loginId });
  userAgent = session.userAgent;
} finally { await session.close(); }
console.log(JSON.stringify({ status: "CODEX_CLI_READY", version: CODEX_CLI_VERSION,
  loggedIn: false, authUrlGenerated: true, containerRemoved: true, userAgent }));
