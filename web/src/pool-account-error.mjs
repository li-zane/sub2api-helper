// Account status metadata only; never expose the upstream account/credential object.
export function redactPoolError(value) {
  return String(value || '')
    .replace(/(\bBearer\s+)\S+/gi, '$1<redacted>')
    .replace(/\b(?:sk-|eyJ)[A-Za-z0-9_.-]{16,}/g, '<redacted>')
    .replace(/(["']?(?:access_token|refresh_token|id_token|api[_-]?key|password|cookie|authorization|client_secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, '$1<redacted>')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@')
    .slice(0, 2000).trim();
}
const code = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/.test(value.trim()) ? value.trim() : null;
export function poolAccountError(account) {
  if (account?.status !== 'error') return null;
  const raw = account.error_message ?? account.last_error ?? account.error ?? null;
  let foundCode = code(account.error_code), foundMessage = null, foundStatus = null;
  const visit = (value, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === 'object' && !Array.isArray(value)) {
      foundCode ||= code(value.code ?? value.error_code);
      const status = Number(value.http_status ?? value.status_code ?? value.status);
      if (!foundStatus && Number.isInteger(status) && status >= 400 && status <= 599) foundStatus = status;
      for (const key of ['error', 'detail', 'cause', 'message']) if (value[key] !== undefined) visit(value[key], depth + 1);
    } else if (typeof value === 'string') {
      const text = value.trim().slice(0, 12000);
      try { const parsed = JSON.parse(text); if (parsed !== text) { visit(parsed, depth + 1); return; } } catch {}
      const at = text.indexOf('{');
      if (at > 0) { try { visit(JSON.parse(text.slice(at)), depth + 1); } catch {} }
      foundCode ||= code(text.match(/(?:["']?(?:error_code|code)["']?\s*[:=]\s*["']?)([a-zA-Z][a-zA-Z0-9_.:-]{0,119})/)?.[1]);
      foundCode ||= code(text.match(/\b(?:deactivated_workspace|workspace_deactivated|workspace_disabled|account_deactivated|organization_deactivated|invalid_grant|token_expired|recent_auth_required)\b/)?.[0]);
      const status = Number(text.match(/\b(?:HTTP|status(?:_code)?)\s*[:=]?\s*(4\d\d|5\d\d)\b/i)?.[1]);
      if (!foundStatus && status) foundStatus = status;
      // Prefer a nested human message to an enclosing serialized payload.
      if (!foundMessage && text && !text.includes('{')) foundMessage = redactPoolError(text);
    }
  };
  visit(raw);
  const message = foundMessage || redactPoolError(typeof raw === 'string' ? raw : raw ? JSON.stringify(raw) : '');
  return { accountId: String(account.id || ''), code: foundCode, message: message || '上游未提供错误详情', httpStatus: foundStatus };
}
export function poolErrorTooltip(errors = []) {
  if (!errors.length) return '已加入号池，但 Sub2API 中账号状态为错误；上游未提供错误详情';
  return errors.map(error => [error.accountId ? `号池账号 #${error.accountId}` : '号池错误', error.code ? `错误代码：${error.code}` : '上游未提供错误代码', error.httpStatus ? `HTTP ${error.httpStatus}` : null, error.message].filter(Boolean).join('\n')).join('\n\n');
}
