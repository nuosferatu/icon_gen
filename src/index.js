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
  if (text.length > 200000) throw new Error('Request too large');
  return JSON.parse(text);
}
async function authenticated(request, env) {
  const token = cookie(request);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?').bind(await digest(token), Date.now()).first();
  return !!row;
}
function validateHistory(history) {
  if (!Array.isArray(history) || history.length < 1 || history.length > 40 || history.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 6000)) throw new Error('Chat history is invalid or too long');
  if (!history.some(m => m.role === 'user')) throw new Error('Enter an image request first');
  return history.map(({role, content}) => ({role, content}));
}
async function deepseek(env, messages, structured = true) {
  if (!env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured');
  const payload = { model: env.DEEPSEEK_MODEL || 'deepseek-flash', messages, thinking: { type: 'disabled' }, temperature: 0.5 };
  if (structured) payload.response_format = { type: 'json_object' };
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(payload)
  });
  if (!response.ok) { console.error('DeepSeek request failed', response.status); throw new Error(`DeepSeek request failed (HTTP ${response.status}). Check the API key, balance, and model configuration.`); }
  const data = await response.json();
  if (data.choices?.[0]?.finish_reason === 'length') throw new Error('DeepSeek output was truncated. Please try again.');
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek returned no content. Please try again.');
  if (!structured) return content;
  try { return JSON.parse(content); } catch { throw new Error('DeepSeek returned invalid structured content. Please try again.'); }
}
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || typeof spec.prompt !== 'string' || !spec.prompt.trim() || spec.prompt.length > 2048 || JSON.stringify(spec).length > 30000) throw new Error('Invalid preset');
  return spec;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return fail('Untrusted request origin', 403);
      if (request.method !== 'GET' && !(request.headers.get('Content-Type') || '').includes('application/json')) return fail('Expected a JSON request', 415);
      if (url.pathname === '/api/login' && request.method === 'POST') {
        if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 16) return fail('APP_PASSWORD must be configured with at least 16 characters', 503);
        const ip = request.headers.get('CF-Connecting-IP') || 'local';
        const now = Date.now(), windowStart = now - 15 * 60 * 1000;
        // Atomic upsert prevents concurrent requests from bypassing the attempt limit.
        const attempt = await env.DB.prepare('INSERT INTO login_attempts (ip, attempts, window_start) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET attempts = CASE WHEN window_start < ? THEN 1 ELSE attempts + 1 END, window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END RETURNING attempts').bind(ip, now, windowStart, windowStart, now).first();
        if (attempt.attempts > 10) return fail('Too many attempts. Please try again in 15 minutes.', 429);
        const input = await body(request);
        if (typeof input.password !== 'string' || !(await equal(input.password, env.APP_PASSWORD))) return fail('Incorrect password', 401);
        await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
        const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
        await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now).run();
        await env.DB.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').bind(await digest(token), now + 7 * 86400000).run();
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, request, 604800) });
      }
      if (!(await authenticated(request, env))) return fail('Please log in', 401);
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
        const input = await body(request), history = validateHistory(input.history);
        const preset = input.preset == null ? null : validateSpec(input.preset);
        const previousSvg = input.previousSvg;
        if (previousSvg != null && (typeof previousSvg !== 'string' || previousSvg.length > 50000 || !/^<svg[\s>]/i.test(previousSvg.trim()))) return fail('The previous image is invalid. Please start a new chat.');
        const raw = await deepseek(env, [
          {role:'system', content:'请根据用户的描述和多轮对话生成图像。用 SVG 格式表达画面，返回完整 SVG 源码。图像的内容、风格、颜色和构图遵循用户要求；如有基础预设，以用户最新的明确修改为准。'},
          ...(preset ? [{role:'system',content:`基础预设：${JSON.stringify(preset)}`}] : []),
          ...(previousSvg ? [{role:'system',content:`上一版图像的 SVG 源码：\n${previousSvg}\n请根据接下来的对话修改或保留画面。`}] : []),
          ...history
        ], false);
        const start = raw.indexOf('<svg'), end = raw.lastIndexOf('</svg>');
        if (start < 0 || end < start || end + 6 - start > 50000) throw new Error('DeepSeek did not return a complete SVG. Please try again.');
        const svg = raw.slice(start, end + 6);
        const latest = [...history].reverse().find(message => message.role === 'user').content;
        return json({reply: '已生成', prompt: latest.slice(0, 2048), svg});
      }
      if (url.pathname === '/api/summarize' && request.method === 'POST') {
        const input = await body(request), history = validateHistory(input.history);
        const preset = input.preset == null ? null : validateSpec(input.preset);
        const summary = await deepseek(env, [
          {role:'system', content:'你的任务是压缩关于生图需求的对话上下文，而不是总结普通聊天或评价生成结果。综合基础预设与全部对话，提取当前有效的图像生成要求；用户后续明确修改覆盖旧要求，未被修改的要求保留。输出 JSON 对象，按需包含主体、风格、构图、色彩、背景、细节、约束、排除项和未明确的信息。尽量具体、简洁，不要虚构用户未提出的要求，不要把助手的“已生成”等状态当作画面描述。所有字段名称和描述使用中文，专有名词可保留原文。只输出 JSON。'},
          ...(preset ? [{role:'system',content:`基础预设：${JSON.stringify(preset)}`}] : []),
          ...history
        ]);
        if (!summary || typeof summary !== 'object' || Array.isArray(summary) || JSON.stringify(summary).length > 30000) throw new Error('DeepSeek returned an invalid image requirements summary. Please try again.');
        return json({summary});
      }
      if (url.pathname === '/api/presets' && request.method === 'POST') {
        const input = await body(request), history = validateHistory(input.history);
        const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
        if (!name || typeof input.lastPrompt !== 'string' || !input.lastPrompt.trim() || input.lastPrompt.length > 2048) return fail('Provide a preset name and generate an image first');
        const previous = input.preset == null ? null : validateSpec(input.preset);
        const spec = validateSpec(await deepseek(env, [
          {role:'system', content:'你是图像生成规范整理专家。根据基础预设、全部对话及最终生成提示词，整合成具体、详细、完整、约束明确的可复用 JSON 规范。保留用户最新修改，区分明确要求与未指定内容，不要虚构用户要求。字段值使用中文，专有名词可保留原文。输出 JSON 对象，包含 title、subject、composition、style、palette、lighting、background、constraints（数组）、avoid（数组）、prompt（中文完整提示词，不超过 1800 字符）。只输出 JSON。'},
          ...(previous ? [{role:'system',content:`基础预设：${JSON.stringify(previous)}`}] : []), ...history,
          {role:'user',content:`最终用于生成满意图片的提示词：${input.lastPrompt}。请生成可复用的结构化 JSON 预设。`}
        ]));
        const id = crypto.randomUUID(), created_at = new Date().toISOString();
        await env.DB.prepare('INSERT INTO presets (id, name, spec, created_at) VALUES (?, ?, ?, ?)').bind(id, name, JSON.stringify(spec), created_at).run();
        return json({ preset: { id, name, spec, created_at } }, 201);
      }
      return fail('API endpoint not found', 404);
    } catch (error) {
      console.error('API error:', error);
      return fail(error instanceof SyntaxError ? 'Invalid JSON' : error.message || 'Service temporarily unavailable', 400);
    }
  }
};
