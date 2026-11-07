import { isVirtualSmsPool } from "./sms-pool-policy.mjs";
import { rankedSmsBowerOffers, smsPriceUnits, summarizeSmsBowerOffers } from "./smsbower-ranked.mjs";
import { smsOrderCost } from "./sms-order-cost.mjs";
import { SMSBOWER_CURRENCY } from "../web/src/sms-money.mjs";

const DEFAULT_API_BASE = "https://smsbower.page/stubs/handler_api.php";
const DEFAULT_TIMEOUT_MS = 12_000;

export class SmsBowerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SmsBowerError";
    this.code = options.code ?? null;
    this.terminal = Boolean(options.terminal);
  }
}

export function createSmsBowerClient(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const apiBase = new URL(options.apiBase || DEFAULT_API_BASE);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const catalogBase = new URL(options.catalogBase || "https://smsbower.app/activations/getPricesByService");

  if (!apiKey) return null;
  if (!/^https?:$/.test(apiBase.protocol)) throw new Error("SMSBower API 地址必须使用 HTTP 或 HTTPS");

  async function request(action, params = {}) {
    const url = new URL(apiBase);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("action", action);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "text/plain,application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      const text = (await response.text()).trim();
      if (!response.ok) throw new SmsBowerError(`接码平台返回 HTTP ${response.status}`, { terminal: response.status < 500 });
      if (!text) throw new SmsBowerError("接码平台返回了空响应");
      return text;
    } catch (error) {
      if (error?.name === "AbortError") throw new SmsBowerError("接码平台请求超时");
      if (error instanceof SmsBowerError) throw error;
      throw new SmsBowerError(`接码平台请求失败：${safeMessage(error?.message)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function setStatus(activationId, status) {
    const text = await request("setStatus", { id: activationId, status });
    if (["ACCESS_READY", "ACCESS_RETRY_GET", "ACCESS_ACTIVATION", "ACCESS_CANCEL"].includes(text)) return true;
    throw responseError(text, "更新号码状态失败");
  }

  async function readCatalog(service) {
    async function read(serviceId) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = new URL(catalogBase);
        url.searchParams.set("serviceId", String(serviceId));
        url.searchParams.set("withPopular", "1");
        // Public catalogue only: never send the paid API key or account cookies.
        const response = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
        if (!response.ok) throw new Error();
        return await response.json();
      } catch { throw new SmsBowerError("SMSBower 等级数据读取失败，已停止取号", { code: "RANKS_UNAVAILABLE", terminal: true }); }
      finally { clearTimeout(timer); }
    }
    // The public catalogue also returns its service-code to internal-ID directory.
    let catalog = await read(247);
    const record = Object.values(catalog?.services || {}).find(item => item?.activate_org_code === service);
    if (!record?.id) throw new SmsBowerError("SMSBower 服务等级数据不可用，已停止取号", { terminal: true });
    if (String(record.id) !== "247") catalog = await read(record.id);
    return catalog;
  }

  async function loadOffers(service, country, maxPrice, selectionMode, excludedPools = []) {
    if (!["country", "global"].includes(selectionMode)) throw new SmsBowerError("请选择有效的 SMSBower 选号方式", { terminal: true });
    if (selectionMode === "country" && !/^\d{1,5}$/.test(String(country))) throw new SmsBowerError("请输入有效的 SMSBower 国家 ID", { terminal: true });
    if (smsPriceUnits(maxPrice) === null || smsPriceUnits(maxPrice) <= 0n) throw new SmsBowerError("请设置 SMSBower 最高价格（USD）", { terminal: true });
    if (selectionMode === "country" && isVirtualSmsPool({}, country)) return [];
    const params = selectionMode === "country" ? { service, country } : { service };
    const [text, catalog] = await Promise.all([request("getPricesV3", params), readCatalog(service)]);
    return rankedSmsBowerOffers(parseJsonResponse(text, "供应商价格响应不正确"), catalog, service, country, maxPrice, selectionMode, excludedPools);
  }

  async function purchaseNumber(params) {
      // V2 returns the allocated order's activationCost. Retry a purchase using
      // legacy V1 ONLY after an explicit unsupported-action response, never
      // after a timeout, malformed success or ambiguous HTTP error.
      let text = await request("getNumberV2", params);
      if (text === "BAD_ACTION") text = await request("getNumber", params);
      if (text.startsWith("{")) {
        const order = parseJsonResponse(text, "获取手机号响应格式不正确");
        const cost = smsOrderCost(order.activationCost, order.currency ?? order.activationCurrency ?? SMSBOWER_CURRENCY);
        if (!["string", "number"].includes(typeof order.activationId) || !String(order.activationId).trim()) throw new SmsBowerError("获取手机号响应缺少订单编号");
        const allocated = { requestId: String(order.activationId), ...(cost ? { cost } : {}) };
        try {
          const result = { ...allocated, number: normalizePhoneNumber(order.phoneNumber ?? "") };
          if (order.activationCost !== undefined && (!cost || cost.currency !== "USD" || smsPriceUnits(cost.amount) > smsPriceUnits(params.maxPrice))) {
            throw new SmsBowerError("取号金额或币种超出预算约束，已保留订单待取消", { terminal: true });
          }
          return result;
        }
        catch (error) {
          // Preserve a known paid order even when its phone payload is broken;
          // the console can log it and durably cancel instead of losing it.
          error.smsOrder = { ...allocated, number: /^\+?\d{1,20}$/.test(String(order.phoneNumber)) ? String(order.phoneNumber) : "未知" };
          throw error;
        }
      }
      const match = /^ACCESS_NUMBER:([^:]+):([^:]*)$/.exec(text);
      if (!match) throw responseError(text, "获取手机号失败");
      try { return { number: normalizePhoneNumber(match[2]), requestId: match[1] }; }
      catch (error) { error.smsOrder = { requestId: match[1], number: "未知" }; throw error; }
  }

  return {
    async getBalance() {
      const text = await request("getBalance");
      const match = /^ACCESS_BALANCE:(\d{1,12}(?:\.\d{1,12})?)$/.exec(text);
      if (match) return { amount: match[1], currency: SMSBOWER_CURRENCY };
      if (/^(?:BAD_KEY|BAD_ACTION|BANNED)$/.test(text)) throw responseError(text, "查询余额失败");
      throw new SmsBowerError("余额接口返回格式不正确", { code: "INVALID_BALANCE", terminal: true });
    },

    async estimateNumbers(service, country, maxPrice, selectionMode = "country") {
      const offers = await loadOffers(service, country, maxPrice, selectionMode);
      return { ...summarizeSmsBowerOffers(offers), selectionMode, country: selectionMode === "country" ? String(country) : null, maxPrice: String(maxPrice), currency: SMSBOWER_CURRENCY };
    },

    async getNumber(service, country, maxPrice = "", selectionMode = "country", options = {}) {
      if (selectionMode === "country" && isVirtualSmsPool({}, country)) throw new SmsBowerError("所选国家属于虚拟号码池，已直接排除，请更换非虚拟国家或选择不限国家", { code: "VIRTUAL_COUNTRY_EXCLUDED", terminal: true });
      const offers = await loadOffers(service, country, maxPrice, selectionMode, options.excludedPools || []);
      for (const offer of offers) {
        try {
          const order = await purchaseNumber({ service, country: offer.country, maxPrice: offer.price, providerIds: offer.providerId });
          return { ...order, providerId: offer.providerId, rank: offer.rank, quotedPrice: offer.price, country: offer.country, countryName: offer.countryName };
        } catch (error) {
          if (error.smsOrder) error.smsOrder = { ...error.smsOrder, providerId: offer.providerId, rank: offer.rank, quotedPrice: offer.price, country: offer.country, countryName: offer.countryName };
          // Only an explicit no-stock response proves that no paid order exists.
          if (error.code !== "NO_NUMBERS" || error.smsOrder) throw error;
        }
      }
      throw new SmsBowerError("所选范围价格上限内没有可用的非虚拟 Gold / Silver / Bronze 号码（已跳过被排除的号池）", { code: "NO_NUMBERS", terminal: true });
    },

    async getPriceOptions(service) {
      const [pricesText, countriesText] = await Promise.all([
        request("getPrices", { service }),
        request("getCountries"),
      ]);
      return normalizePriceOptions(
        parseJsonResponse(pricesText, "价格接口返回格式不正确"),
        parseJsonResponse(countriesText, "国家接口返回格式不正确"),
        service,
      );
    },

    async getSms(activationId) {
      const text = await request("getStatus", { id: activationId });
      if (text === "STATUS_WAIT_CODE" || text.startsWith("STATUS_WAIT_RETRY")) return { status: "waiting" };
      if (text === "STATUS_CANCEL") throw new SmsBowerError("号码激活已被平台取消", { code: text, terminal: true });
      if (text.startsWith("STATUS_OK:")) {
        const code = findSixDigitCode(text.slice("STATUS_OK:".length));
        if (!code) throw new SmsBowerError("接码平台返回内容中没有找到独立的 6 位数字验证码", { terminal: true });
        return { status: "received", code };
      }
      throw responseError(text, "获取短信失败");
    },

    markReady(activationId) {
      return setStatus(activationId, 1);
    },

    complete(activationId) {
      return setStatus(activationId, 6);
    },

    release(activationId) {
      return setStatus(activationId, 8);
    },
  };
}

function responseError(value, fallback) {
  const code = safeMessage(value) || "UNKNOWN_ERROR";
  const descriptions = {
    BAD_KEY: "API Key 不正确",
    BAD_ACTION: "接口动作不正确",
    BAD_SERVICE: "服务代码不正确",
    NO_NUMBERS: "当前国家和服务暂无可用号码",
    NO_BALANCE: "账户余额不足",
    NO_ACTIVATION: "激活订单不存在",
    BAD_STATUS: "号码状态不正确",
    EARLY_CANCEL_DENIED: "当前订单暂时不允许取消",
  };
  const terminal = /^(?:BAD_KEY|BAD_ACTION|BAD_SERVICE|NO_BALANCE|NO_ACTIVATION|BAD_STATUS|BANNED)/.test(code);
  return new SmsBowerError(`${fallback}：${descriptions[code] || code}`, { code, terminal });
}

function findSixDigitCode(value) {
  return /(?:^|\D)(\d{6})(?!\d)/.exec(String(value || ""))?.[1] || null;
}

function parseJsonResponse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    throw responseError(value, fallback);
  }
}

function normalizePriceOptions(prices, countries, service) {
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
    throw new SmsBowerError("价格接口返回格式不正确", { terminal: true });
  }
  const countryList = collectCountryRecords(countries);
  const countryIndex = new Map();
  countryList.forEach((country) => {
    const keys = [country.activate_org_code, country.id, country.slug, country.title, country.eng, country.chn, country.iso, country.__alias];
    keys.filter((key) => key !== undefined && key !== null && key !== "").forEach((key) => {
      countryIndex.set(String(key).toLowerCase(), country);
    });
  });

  const options = new Map();
  Object.entries(prices).forEach(([countryKey, services]) => {
    const details = services?.[service] || services;
    const cost = Number(details?.cost);
    const count = Number(details?.count);
    if (!Number.isFinite(cost) || cost < 0 || !Number.isFinite(count) || count <= 0) return;
    const countryInfo = countryIndex.get(String(countryKey).toLowerCase()) || {};
    const country = String(countryInfo.activate_org_code ?? countryKey);
    if (!/^\d{1,5}$/.test(country) || isVirtualSmsPool(countryInfo, country)) return;
    const option = {
      country,
      title: safeMessage(countryInfo.chn || countryInfo.title || countryInfo.eng || fallbackCountryName(country)),
      iso: /^[A-Z]{2}$/.test(String(countryInfo.iso || "").toUpperCase())
        ? String(countryInfo.iso).toUpperCase()
        : "",
      prefix: String(countryInfo.prefix || "").replace(/\D/g, "").slice(0, 4),
      price: cost,
      currency: SMSBOWER_CURRENCY,
      count: Math.floor(count),
    };
    const existing = options.get(country);
    if (!existing || option.price < existing.price) options.set(country, option);
  });

  const result = [...options.values()].sort((left, right) => (
    left.price - right.price
    || right.count - left.count
    || left.title.localeCompare(right.title)
  ));
  if (!result.length) throw new SmsBowerError("OpenAI 当前没有可购买的国家号码", { terminal: true });
  return result;
}

function collectCountryRecords(value) {
  const records = [];
  const visit = (item, alias = "", depth = 0) => {
    if (!item || depth > 5) return;
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, String(index), depth + 1));
      return;
    }
    if (typeof item !== "object") return;
    if (item.id !== undefined && (item.chn || item.eng || item.title || item.iso)) {
      records.push({ ...item, __alias: alias });
      return;
    }
    Object.entries(item).forEach(([key, entry]) => visit(entry, key, depth + 1));
  };
  visit(value);
  return records;
}

function fallbackCountryName(country) {
  return {
    7: "马来西亚",
    12: "美国（虚拟号码）",
    16: "英国",
    187: "美国",
    1001: "日本",
  }[country] || `国家 ${country}`;
}

function normalizePhoneNumber(value) {
  let phone = String(value || "").trim().replace(/[\s()-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  else if (!phone.startsWith("+")) phone = `+${phone}`;
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new SmsBowerError("接码平台返回的手机号不是有效的国际格式", { terminal: true });
  }
  return phone;
}

function safeMessage(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}
