const encoder = new TextEncoder();
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const fail = (message, status = 400) => json({ error: message }, status);
const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), x => x.toString(16).padStart(2, '0')).join('');
const equal = async (a, b) => {
  const x = await digest(a), y = await digest(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return difference === 0;
};
const cookie = (request) => (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith('session='))?.slice(8);
const sessionCookie = (token, request, maxAge) => `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
async function body(request) {
  const text = await request.text();
  if (text.length > 200000) throw new Error('请求过大');
  return JSON.parse(text);
}
async function authenticated(request, env) {
  const token = cookie(request);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(await digest(token), Date.now()).first();
  return !!row;
}
function validateHistory(history) {
  if (!Array.isArray(history) || history.length < 1 || history.length > 40 || history.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 6000)) throw new Error('对话内容无效或过长');
  if (!history.some(m => m.role === 'user')) throw new Error('请先输入创作需求');
  return history.map(({role, content}) => ({role, content}));
}
async function deepseek(env, messages) {
  if (!env.DEEPSEEK_API_KEY) throw new Error('尚未配置 DEEPSEEK_API_KEY');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({ model: env.DEEPSEEK_MODEL || 'deepseek-flash', messages, response_format: { type: 'json_object' }, temperature: 0.5 })
  });
  if (!response.ok) { console.error('DeepSeek request failed', response.status); throw new Error(`DeepSeek 请求失败（HTTP ${response.status}），请检查密钥、余额及模型配置`); }
  const data = await response.json();
  try { return JSON.parse(data.choices[0].message.content); } catch { throw new Error('DeepSeek 返回的结构化内容无效，请重试'); }
}
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.prompt !== 'string' || !spec.prompt.trim() || spec.prompt.length > 2048 || JSON.stringify(spec).length > 30000) throw new Error('预设内容无效');
  return spec;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return fail('请求来源不受信任', 403);
      if (request.method !== 'GET' && !(request.headers.get('Content-Type') || '').includes('application/json')) return fail('需要 JSON 请求', 415);
      if (url.pathname === '/api/login' && request.method === 'POST') {
        if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 16) return fail('服务未配置至少 16 个字符的 APP_PASSWORD', 503);
        const ip = request.headers.get('CF-Connecting-IP') || 'local';
        const now = Date.now(), windowStart = now - 15 * 60 * 1000;
        // Atomic upsert prevents concurrent requests from bypassing the attempt limit.
        const attempt = await env.DB.prepare('INSERT INTO login_attempts (ip, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET attempts = CASE WHEN window_start < ? THEN 1 ELSE attempts + 1 END, window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END RETURNING attempts').bind(ip, now, windowStart, windowStart, now).first();
        if (attempt.attempts > 10) return fail('尝试次数过多，请 15 分钟后重试', 429);
        const input = await body(request);
        if (typeof input.password !== 'string' || !(await equal(input.password, env.APP_PASSWORD))) return fail('密码不正确', 401);
        await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
        await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
        await env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').bind(await digest(token), now + 7 * 86400000).run();
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, request, 604800) });
      }
      if (!(await authenticated(request, env))) return fail('请先登录', 401);
      if (url.pathname === '/api/session' && request.method === 'GET') return json({ ok: true });
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await digest(cookie(request))).run();
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', request, 0) });
      }
      if (url.pathname === '/api/presets' && request.method === 'GET') {
        const result = await env.DB.prepare('SELECT id, name, spec, created_at FROM presets ORDER BY created_at DESC').all();
        return json({ presets: result.results.map(row => ({ ...row, spec: JSON.parse(row.spec) })) });
      }
      if (url.pathname.startsWith('/api/presets/') && request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM presets WHERE id = ?').bind(url.pathname.slice('/api/presets/'.length)).run();
        return json({ ok: true });
      }
      if (url.pathname === '/api/generate' && request.method === 'POST') {
        return fail('图片生成接口尚未配置。请提供 DeepSeek 生图 API 文档或可运行的请求示例。', 503);
      }
      if (url.pathname === '/api/presets' && request.method === 'POST') {
        const input = await body(request), history = validateHistory(input.history);
        const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
        if (!name || typeof input.lastPrompt !== 'string' || !input.lastPrompt.trim() || input.lastPrompt.length > 2048) return fail('请提供预设名称并先生成图片');
        const previous = input.preset == null ? null : validateSpec(input.preset);
        const spec = validateSpec(await deepseek(env, [
          {role:'system', content:'你是图像生成规范整理专家。根据基础预设、全部对话及最终生成提示词，整合成具体、详细、完整、约束明确的可复用 JSON 规范。保留用户最新修改，区分明确要求与未指定内容，不要虚构用户要求。输出 JSON 对象，包含 title、subject、composition、style、palette、lighting、background、constraints（数组）、avoid（数组）、prompt（英文完整提示词，不超过 1800 字符）。只输出 JSON。'},
          ...(previous ? [{role:'system',content:`基础预设：${JSON.stringify(previous)}`}] : []), ...history,
          {role:'user',content:`最终用于生成满意图片的提示词：${input.lastPrompt}。请生成可复用的结构化 JSON 预设。`}
        ]));
        const id = crypto.randomUUID(), created_at = new Date().toISOString();
        await env.DB.prepare('INSERT INTO presets (id, name, spec, created_at) VALUES (?, ?, ?, ?)').bind(id, name, JSON.stringify(spec), created_at).run();
        return json({ preset: { id, name, spec, created_at } }, 201);
      }
      return fail('接口不存在', 404);
    } catch (error) {
      console.error('API error:', error);
      return fail(error instanceof SyntaxError ? 'JSON 格式无效' : error.message || '服务暂时不可用', 400);
    }
  }
};
