import fs from "node:fs/promises";
import path from "node:path";
import { getAccountBrowserIdentity } from "../src/account-browser-identity.mjs";
import { writeAccountWebSession } from "../src/account-web-session.mjs";

export async function seedWebSession(outputPath, options = {}) {
  const account = JSON.parse(await fs.readFile(outputPath, "utf8")).accounts[0];
  const email = options.email || account.credentials.email || "fixture@example.test";
  const identity = await getAccountBrowserIdentity(email, { root: path.join(path.dirname(outputPath), "browser-identities") });
  const accessToken = options.accessToken || `web.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  const session = { email: identity.email, identity,
    cookies: [{ name: "__Secure-next-auth.session-token", value: "fixture-web-cookie", domain: "127.0.0.1", path: "/", hostOnly: true }],
    web: { workspaceId: account.credentials.chatgpt_account_id }, accessToken,
  };
  await writeAccountWebSession(path.join(path.dirname(outputPath), "web-session.json"), session);
  return session;
}
