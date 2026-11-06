import fs from "node:fs/promises";
import { createSmsProvider, SMS_PROVIDER_DEFINITIONS } from "./sms-providers.mjs";
import { writePrivateJsonAtomic } from "./account-history.mjs";

export const emptySmsSettings = () => ({ selectedProviderId: "luban", autoAcquire: false, configs: {} });

export function normalizeSmsSettings(value, { validate = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("接码配置格式不正确");
  const definition = SMS_PROVIDER_DEFINITIONS.find(item => item.id === value.selectedProviderId);
  if (!definition) throw new Error("请选择接码平台");
  if (value.autoAcquire !== undefined && typeof value.autoAcquire !== "boolean") throw new Error("自动取号开关必须为布尔值");
  const config = {};
  const raw = value.configs?.[definition.id] || {};
  for (const field of definition.fields) {
    const input = raw[field.key] ?? field.defaultValue ?? "";
    if (typeof input !== "string" || input.length > (field.key === "entries" ? 500_000 : 1024)) throw new Error("接码配置字段格式不正确");
    config[field.key] = input.trim();
  }
  if (validate) createSmsProvider(definition.id, config);
  return { selectedProviderId: definition.id, autoAcquire: value.autoAcquire === true, configs: { [definition.id]: config } };
}

export async function loadSmsSettings(file) {
  try { return { configured: true, settings: normalizeSmsSettings(JSON.parse(await fs.readFile(file, "utf8"))) }; }
  catch (error) {
    if (error.code === "ENOENT") return { configured: false, settings: emptySmsSettings() };
    // Fail closed; a damaged file must never silently enable paid acquisition.
    return { configured: false, settings: emptySmsSettings(), error: "接码配置读取失败，请重新保存配置" };
  }
}

export async function saveSmsSettings(file, input) {
  const settings = normalizeSmsSettings(input);
  await writePrivateJsonAtomic(file, settings);
  return settings;
}
