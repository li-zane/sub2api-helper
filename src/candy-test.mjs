import { createHash } from 'node:crypto';

// Question/table from jiangzhi-jiance. Only the answer-format instruction is
// appended; the expected answer and grading rules never enter the prompt.
export const CANDY_QUESTION = "黑色袋子中有苹果、桃子、西瓜三种口味的糖果，圆形与五角星形可以靠手感区分。活动前决定取出的总数，最少取多少个，才能保证同时拥有不同形状的苹果味和桃子味糖果？\n\n各口味与形状的糖果数量：\n形状 | 苹果味 | 桃子味 | 西瓜味\n圆形 | 7 | 9 | 8\n五角星形 | 7 | 6 | 4";
export const CANDY_PROMPT = CANDY_QUESTION + '\n\n请先给出推理，最后一行必须严格使用 <final_answer>整数</final_answer> 输出你确定的最终答案；将“整数”替换为答案数字，标签内不写单位、算式或多个候选值。仅在最后一行输出该标签，不要在推理中重复它。';
export const CANDY_PROMPT_SHA256 = createHash('sha256').update(CANDY_PROMPT).digest('hex');

const integer = text => Number.isSafeInteger(Number(text)) ? Number(text) : null;
export function extractCandyFinalAnswer(text) {
  const raw = String(text).trim();
  // The last designated result is authoritative, including a malformed result:
  // never fall back to a plausible number from earlier reasoning/corrections.
  const markers = [...raw.matchAll(/<final_answer\s*>/gi)];
  if (markers.length) {
    const last = raw.slice(markers.at(-1).index);
    const match = last.match(/^<final_answer\s*>\s*([+-]?\d+)\s*<\/final_answer\s*>/i);
    return { answer: match ? integer(match[1]) : null, source: 'final_answer' };
  }
  const normalized = raw.replace(/[*`_]/g, '');
  try { const value = JSON.parse(normalized); if (Number.isSafeInteger(value?.answer)) return { answer: value.answer, source: 'json' }; } catch {}
  const direct = normalized.match(/^([+-]?\d+)(?:\s*[个颗])?[。.!！]?$/);
  if (direct) return { answer: integer(direct[1]), source: 'direct' };

  // Compatibility with saved answers and models that omit the new marker.
  // Collect only explicit answer forms, then inspect the latest one first.
  const candidates = [];
  const add = (pattern, source) => {
    for (const match of normalized.matchAll(pattern)) {
      const tail = normalized.slice(match.index + match[0].length);
      const ambiguous = /^\s*(?:或(?:者)?|or\b|\/|、|至|到|~|-)\s*\d/i.test(tail);
      candidates.push({ index: match.index, answer: ambiguous ? null : integer(match[1]), source });
    }
  };
  add(/\\boxed\s*\{\s*([+-]?\d+)\s*(?:\\(?:text|mathrm)\s*\{\s*(?:个|颗)\s*\}|(?:个|颗))?\s*\}/g, 'boxed');
  add(/(?:最终答案|最终结论|正确答案|答案|final answer|answer)\s*(?:(?:是|为|is)\s*)?[:：=]?\s*([+-]?\d+)(?![\d.])\s*(?:个|颗)?/gi, 'answer_text');
  add(/(?:最少|至少)\s*(?:需要|要)?\s*(?:取出|取|拿出|抽取)?\s*[:：]?\s*([+-]?\d+)(?![\d.])\s*(?:个|颗)/g, 'natural_text');
  const last = candidates.sort((a,b) => b.index - a.index)[0];
  return last ? { answer: last.answer, source: last.source } : { answer: null, source: null };
}
export function gradeCandy(text) {
  const normalized = String(text).replace(/[*`_]/g, '').trim();
  const websiteRulePassed = /(?<![\d.])21(?![\d.])/.test(normalized);
  const { answer, source } = extractCandyFinalAnswer(text);
  return { status: answer === null ? 'unknown' : answer === 21 ? 'match' : 'mismatch', expectedAnswer: 21, extractedFinalAnswer: answer, websiteRulePassed,
    reason: answer === null ? '未能明确提取最终答案' : answer === 21 ? '糖果题最终答案为 21，单题通过' : `糖果题最终答案为 ${answer}，单题未通过`,
    assessment: 'single-task-performance', extractionSource: source };
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
