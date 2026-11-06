import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptySmsSettings, normalizeSmsSettings, loadSmsSettings, saveSmsSettings } from "../src/sms-settings.mjs";
import { oauthErrorMessage } from "../src/oauth-errors.mjs";
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "helper-sms-settings-")), file = path.join(dir, "settings.json");
const settings = { selectedProviderId: "smsbower", autoAcquire: true, configs: { smsbower: { apiKey: "fixture-sms-key", service: "dr", country: "1001", maxPrice: "0.42" }, ignored: { password: "ignore" } } };
try {
  assert.equal(emptySmsSettings().autoAcquire, false);
  assert.equal(emptySmsSettings().maxAutoNumbers, 3);
  assert.equal(normalizeSmsSettings(settings).maxAutoNumbers, 3);
  for (const maxAutoNumbers of [0, 11, 1.5, "3", false]) assert.throws(() => normalizeSmsSettings({ ...settings, maxAutoNumbers }));
  assert.equal(normalizeSmsSettings({ ...settings, maxAutoNumbers: 2 }).maxAutoNumbers, 2);
  assert.match(oauthErrorMessage("CODEX_AUTH_LOGIN_REQUIRED: web session is missing or expired"), /Codex 要求继续账号身份验证/);
  assert.equal(oauthErrorMessage(null), null);
  assert.equal(oauthErrorMessage("SESSION_TOKEN_EXPIRED: real Web failure"), "SESSION_TOKEN_EXPIRED: real Web failure");
  assert.equal((await loadSmsSettings(file)).configured, false);
  assert.equal(normalizeSmsSettings({ ...settings, autoAcquire: undefined }).autoAcquire, false);
  for (const bad of [null, [], { ...settings, autoAcquire: "true" }, { ...settings, selectedProviderId: "bad" }, { ...settings, configs: { smsbower: { apiKey: "short" } } }]) assert.throws(() => normalizeSmsSettings(bad));
  const saved = await saveSmsSettings(file, settings); assert(!saved.configs.ignored);
  assert.deepEqual((await loadSmsSettings(file)).settings, saved);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const before = await fs.readFile(file, "utf8"); await assert.rejects(saveSmsSettings(file, { ...settings, autoAcquire: "true" })); assert.equal(await fs.readFile(file, "utf8"), before);
  await fs.writeFile(file, "invalid JSON"); const corrupt = await loadSmsSettings(file); assert.equal(corrupt.configured, false); assert.equal(corrupt.settings.autoAcquire, false); assert(corrupt.error);
  console.log("SMS_SETTINGS_PASS opt-in default; strict provider/types; private durable selected config; invalid-save preservation; damaged-file fails closed");
} finally { await fs.rm(dir, { recursive: true, force: true }); }
