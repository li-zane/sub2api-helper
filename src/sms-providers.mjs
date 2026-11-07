import { createLubanSmsClient } from "./luban-sms.mjs";
import { createSmsBowerClient } from "./smsbower.mjs";
import { createCustomSmsClient } from "./custom-sms.mjs";

export const SMS_PROVIDER_DEFINITIONS = [
  {
    id: "luban",
    name: "LubanSMS",
    description: "使用供应商编号获取手机号",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "输入 LubanSMS API Key" },
      { key: "serviceId", label: "供应商编号", type: "text", placeholder: "例如 121949", summary: true },
    ],
  },
  {
    id: "smsbower",
    name: "SMSBower",
    description: "指定国家或不限国家，预算内优先 Gold → Silver → Bronze",
    optionsEndpoint: "/api/sms-providers/smsbower/options",
    balanceEndpoint: "/api/sms-providers/smsbower/balance",
    inventoryEndpoint: "/api/sms-providers/smsbower/inventory",
    fields: [
      { key: "apiKey", label: "API Key", type: "password", placeholder: "输入 SMSBower API Key" },
      { key: "service", label: "服务代码", type: "hidden", defaultValue: "dr" },
      { key: "selectionMode", label: "选号方式", type: "select", defaultValue: "country", options: [{ value: "country", label: "指定国家" }, { value: "global", label: "不限国家" }] },
      { key: "country", label: "国家与价格", type: "price-select", defaultValue: "1001", summaryKey: "countryLabel" },
      { key: "maxPrice", label: "最高价格（USD）", type: "number", min: "0.000001", step: "0.000001", placeholder: "例如 0.05", required: true },
      { key: "countryLabel", label: "国家名称", type: "hidden", required: false },
    ],
  },
  {
    id: "custom",
    name: "自定义接码",
    description: "批量粘贴手机号和对应的接码 API",
    fields: [
      {
        key: "entries",
        label: "手机号与接码 API",
        type: "textarea",
        placeholder: "+861871291167----https://example.com/messages/1871291167",
      },
    ],
  },
];

export function publicSmsProviderDefinitions() {
  return SMS_PROVIDER_DEFINITIONS.map((provider) => ({
    ...provider,
    fields: provider.fields.map((field) => ({ ...field })),
  }));
}

export function createSmsProvider(providerIdValue, configValue = {}, options = {}) {
  const providerId = String(providerIdValue || "").trim().toLowerCase();
  const config = configValue && typeof configValue === "object" ? configValue : {};

  if (providerId === "luban") {
    const apiKey = validateApiKey(config.apiKey, "LubanSMS");
    const serviceId = String(config.serviceId || "").trim();
    if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(serviceId)) throw new Error("请输入有效的 LubanSMS 供应商编号");
    const client = createLubanSmsClient({ apiKey, apiBase: options.lubanApiBase, fetchImpl: options.fetchImpl });
    return {
      id: "luban",
      name: "LubanSMS",
      apiKey,
      serviceLabel: serviceId,
      getNumber: () => client.getNumber(serviceId),
      getSms: (requestId) => client.getSms(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  if (providerId === "smsbower") {
    const apiKey = validateApiKey(config.apiKey, "SMSBower");
    const service = String(config.service || "dr").trim().toLowerCase();
    const selectionMode = String(config.selectionMode || "country").trim();
    if (!["country", "global"].includes(selectionMode)) throw new Error("请选择有效的 SMSBower 选号方式");
    const country = String(config.country || "").trim();
    const maxPrice = String(config.maxPrice || "").trim();
    if (!/^[a-z0-9_]{1,32}$/.test(service)) throw new Error("请输入有效的 SMSBower 服务代码");
    if (selectionMode === "country" && !/^\d{1,5}$/.test(country)) throw new Error("请输入有效的 SMSBower 国家 ID");
    if (maxPrice && (!/^\d+(?:\.\d{1,6})?$/.test(maxPrice) || Number(maxPrice) <= 0)) {
      throw new Error("请输入大于 0、最多 6 位小数的 SMSBower 最高价格（USD）");
    }
    const client = createSmsBowerClient({ apiKey, apiBase: options.smsBowerApiBase, catalogBase: options.smsBowerCatalogBase, fetchImpl: options.fetchImpl });
    return {
      id: "smsbower",
      name: "SMSBower",
      apiKey,
      serviceLabel: selectionMode === "global" ? "不限国家" : config.countryLabel || `${service} / ${country}`,
      getNumber: (options = {}) => client.getNumber(service, country, maxPrice, selectionMode, options),
      listNumberOptions: () => client.getPriceOptions(service),
      estimateNumberAvailability: () => client.estimateNumbers(service, country, maxPrice, selectionMode),
      getSms: (requestId) => client.getSms(requestId),
      markReady: (requestId) => client.markReady(requestId),
      complete: (requestId) => client.complete(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  if (providerId === "custom") {
    const client = createCustomSmsClient({
      entries: config.entries,
      fetchImpl: options.fetchImpl,
      acquireEntry: options.acquireCustomSmsEntry,
    });
    return {
      id: "custom",
      name: "自定义接码",
      apiKey: "",
      serviceLabel: `${client.entryCount} 个号码`,
      getNumber: () => client.getNumber(),
      getSms: (requestId) => client.getSms(requestId),
      release: (requestId) => client.release(requestId),
    };
  }

  throw new Error("请选择受支持的接码平台");
}

// Balance lookup only needs a key; incomplete/invalid purchase fields must not block it.
export async function readSmsProviderBalance(providerId, config = {}, options = {}) {
  if (providerId !== "smsbower") throw Object.assign(new Error("该接码平台暂不支持余额查询"), { status: 400 });
  const apiKey = validateApiKey(config?.apiKey, "SMSBower");
  return createSmsBowerClient({ apiKey, apiBase: options.smsBowerApiBase, fetchImpl: options.fetchImpl }).getBalance();
}

function validateApiKey(value, providerName) {
  const apiKey = String(value || "").trim();
  if (!/^[a-zA-Z0-9._-]{8,256}$/.test(apiKey)) throw new Error(`请输入有效的 ${providerName} API Key`);
  return apiKey;
}
