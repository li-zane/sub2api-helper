// Prompt and conservative grading ported from jiangzhi-jiance, retrieved 2026-11-04.
// Keep the answer and local grading rules out of the model's prompt.
export const CANDY_PROMPT = "黑色袋子中有苹果、桃子、西瓜三种口味的糖果，圆形与五角星形可以靠手感区分。活动前决定取出的总数，最少取多少个，才能保证同时拥有不同形状的苹果味和桃子味糖果？\n\n各口味与形状的糖果数量：\n形状 | 苹果味 | 桃子味 | 西瓜味\n圆形 | 7 | 9 | 8\n五角星形 | 7 | 6 | 4";
export const CANDY_PROMPT_SHA256 = '2ab018535731ad59fe5c3f6e4c9dbd12c40519b2b79a8a94021d1737e46ed4a2';
export function gradeCandy(text) {
  const normalized = String(text).replace(/[*`_]/g, '').trim();
  const websiteRulePassed = /(?<![\d.])21(?![\d.])/.test(normalized);
  let answer = null;
  try { const value = JSON.parse(normalized); if (Number.isInteger(value?.answer)) answer = value.answer; } catch {}
  const direct = normalized.match(/^(\d+)(?:\s*[个颗])?[。.!！]?$/);
  if (direct) answer = Number(direct[1]);
  else {
    const final = [...normalized.matchAll(/(?:最终答案|最终结论|final answer)\s*(?:是|为|is|[:：])?\s*(\d+)\s*(?:个|颗)?/gi)];
    const explicit = [...normalized.matchAll(/(?:正确答案|答案|answer)\s*(?:是|为|is|[:：])?\s*(\d+)\s*(?:个|颗)?/gi)];
    const natural = [...normalized.matchAll(/(?:最少|至少)\s*(?:需要|要)?\s*(?:取出|取|拿出|抽取)?\s*(\d+)\s*(?:个|颗)/g)];
    const found = final.length ? final : explicit.length ? explicit : natural;
    if (found.length) answer = new Set(found.map(m => Number(m[1]))).size === 1 ? Number(found[0][1]) : null;
  }
  return { status: answer === null ? 'unknown' : answer === 21 ? 'match' : 'mismatch', expectedAnswer: 21, extractedFinalAnswer: answer, websiteRulePassed,
    reason: answer === null ? '未能明确提取最终答案' : answer === 21 ? '糖果题最终答案为 21，单题通过' : `糖果题最终答案为 ${answer}，单题未通过`,
    assessment: 'single-task-performance' };
}
export const DEFAULT_TEST_SEQUENCE = Object.freeze({first:'fingerprint', fingerprint:1, candy:0});
export function normalizeTestSequence(raw = DEFAULT_TEST_SEQUENCE) {
  const invalid = () => Object.assign(new Error('检测轮换须选择首项；指纹、糖果次数须为 0–100 的整数，且不能同时为 0'),{status:400});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !['fingerprint','candy'].includes(raw.first)) throw invalid();
  const value = {first:raw.first};
  for (const method of ['fingerprint','candy']) {
    if (!['number','string'].includes(typeof raw[method]) || String(raw[method]).trim() === '' || !Number.isInteger(Number(raw[method])) || Number(raw[method]) < 0 || Number(raw[method]) > 100) throw invalid();
    value[method] = Number(raw[method]);
  }
  if (!value.fingerprint && !value.candy) throw invalid();
  return value;
}
export function sequenceStep(sequence, index = 0) {
  const total = sequence.fingerprint + sequence.candy;
  const cursor = Number.isSafeInteger(index) && index >= 0 ? index % total : 0;
  const second = sequence.first === 'fingerprint' ? 'candy' : 'fingerprint';
  const method = cursor < sequence[sequence.first] ? sequence.first : second;
  return {method, position:cursor + 1, total, index:cursor};
}
export function aggregateRequestUsage(models) {
  const requests = models.flatMap(m => m.requests || []);
  const usage = {reportedRequests:requests.filter(r=>r.usage).length,totalRequests:requests.length};
  for (const field of ['inputTokens','cachedInputTokens','outputTokens','reasoningTokens','totalTokens']) {
    const values = requests.map(r=>r.usage?.[field]).filter(Number.isFinite);
    usage[field] = values.length ? values.reduce((a,b)=>a+b,0) : null;
  }
  usage.complete = requests.length > 0 && requests.every(r=>Number.isFinite(r.usage?.inputTokens) && Number.isFinite(r.usage?.outputTokens));
  return usage;
}
