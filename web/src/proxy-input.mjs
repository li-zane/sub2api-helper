const PROTOCOLS = new Set(['http', 'https', 'socks5', 'socks5h']);
const endpoint = /^(\[[^\]]+\]|[^:\s/@?#]+):(\d+)$/;
function fail(message) { throw new Error(message); }
function credentials(text) {
  const colon = text.indexOf(':');
  if (colon < 0) fail('认证信息应为 username:password');
  return { username: text.slice(0, colon), password: text.slice(colon + 1) };
}
function address(text) {
  const match = endpoint.exec(text);
  if (!match) fail('地址应为 host:port，IPv6 请使用 [地址]:port');
  return { host: match[1], port: match[2] };
}
export function normalizeProxyInput(value, now = Date.now()) {
  if (!value || typeof value !== 'object') fail('代理数据不能为空');
  const name = String(value.name ?? '').trim();
  const protocol = String(value.protocol ?? 'http').trim().toLowerCase();
  const host = String(value.host ?? '').trim().replace(/^\[([^\]]+)\]$/, '$1').toLowerCase();
  const portText = String(value.port ?? '').trim(), port = Number(portText);
  if (!name || name.length > 100) fail('代理名称须为 1–100 个字符');
  if (!PROTOCOLS.has(protocol)) fail('协议仅支持 HTTP、HTTPS、SOCKS5、SOCKS5H');
  if (!host || host.length > 253 || /[\s/@?#\\\[\]]/.test(host)) fail('请填写有效的主机地址');
  try { new URL(`http://${host.includes(':') ? `[${host}]` : host}:1`); } catch { fail('请填写有效的主机地址'); }
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) fail('端口须为 1–65535 的整数');
  const username = String(value.username ?? '').trim(), password = String(value.password ?? '').trim();
  if (username.length > 1024 || password.length > 1024 || /[\r\n\0]/.test(username + password)) fail('代理认证信息格式错误');
  if (password && !username) fail('填写密码时也需要用户名');
  const expires_at = value.expires_at == null || value.expires_at === '' ? null : Number(value.expires_at);
  if (expires_at !== null && (!Number.isSafeInteger(expires_at) || expires_at <= now / 1000 || expires_at > 253402300799)) fail('有效期须为未来时间');
  return { name, protocol, host, port, username, password, expires_at };
}
export function parseProxyLines(text, { protocol = 'http', namePrefix = '', expiresAt = null } = {}) {
  const lines = String(text ?? '').split(/\r?\n/).map((text, i) => ({ text: text.trim(), line: i + 1 })).filter(row => row.text);
  if (lines.length > 100) return [{ line: 101, proxy: null, error: '单次最多导入 100 条代理' }];
  return lines.map(({ text, line }, index) => {
    try {
      let selectedProtocol = protocol, parts;
      const scheme = /^([a-z0-9]+):\/\/(.*)$/i.exec(text);
      if (scheme) {
        selectedProtocol = scheme[1].toLowerCase();
        const authority = scheme[2].replace(/\/$/, '');
        if (/[/?#]/.test(authority)) fail('代理 URL 不能包含路径、查询或片段');
        const at = authority.lastIndexOf('@');
        parts = address(at < 0 ? authority : authority.slice(at + 1));
        if (at >= 0) {
          const auth = credentials(authority.slice(0, at));
          try { parts = { ...parts, username: decodeURIComponent(auth.username), password: decodeURIComponent(auth.password) }; }
          catch { fail('URL 认证信息的百分号编码无效'); }
        }
      } else {
        const firstAt = text.indexOf('@'), lastAt = text.lastIndexOf('@');
        let addressFirst = firstAt >= 0 && endpoint.test(text.slice(0, firstAt));
        const addressLast = lastAt >= 0 && endpoint.test(text.slice(lastAt + 1));
        if (addressFirst && addressLast) {
          const qualified = part => /[.\[\]:]/.test(address(part).host) || address(part).host === 'localhost';
          const left = qualified(text.slice(0, firstAt)), right = qualified(text.slice(lastAt + 1));
          if (left === right) fail('格式有歧义，请改用 protocol://username:password@host:port');
          addressFirst = left;
        }
        if (addressFirst) {
          parts = { ...address(text.slice(0, firstAt)), ...credentials(text.slice(firstAt + 1)) };
        } else if (addressLast) {
          parts = { ...address(text.slice(lastAt + 1)), ...credentials(text.slice(0, lastAt)) };
        } else {
          const match = /^(\[[^\]]+\]|[^:\s/@?#]+):(\d+)(?::([^:]*):(.*))?$/.exec(text);
          if (!match) fail('未识别的格式，请按下方示例输入');
          parts = { host: match[1], port: match[2], username: match[3] || '', password: match[4] || '' };
        }
      }
      const name = namePrefix.trim() ? `${namePrefix.trim()}-${index + 1}` : `${parts.host}:${parts.port}`;
      return { line, proxy: normalizeProxyInput({ ...parts, protocol: selectedProtocol, name, expires_at: expiresAt }), error: null };
    } catch (error) { return { line, proxy: null, error: error.message }; }
  });
}
