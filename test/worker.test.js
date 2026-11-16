import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

function database() {
  const sessions = new Map(), attempts = new Map(), presets = new Map();
  return { prepare(sql) { let args; return { bind(...values) { args = values; return this; }, async first() {
    if (sql.startsWith('SELECT expires_at')) { const expiry = sessions.get(args[0]); return expiry > args[1] ? {expires_at:expiry} : null; }
    if (sql.startsWith('INSERT INTO login_attempts')) { let row = attempts.get(args[0]); row = !row || row.start < args[2] ? {count:1,start:args[1]} : {count:row.count+1,start:row.start}; attempts.set(args[0],row); return {attempts:row.count}; }
    throw new Error(sql);
  }, async run() {
    if (sql.startsWith('DELETE FROM login_attempts')) attempts.delete(args[0]);
    else if (sql.startsWith('DELETE FROM sessions WHERE expires_at')) { for (const [key,expiry] of sessions) if (expiry <= args[0]) sessions.delete(key); }
    else if (sql.startsWith('INSERT INTO sessions')) sessions.set(args[0],args[1]);
    else if (sql.startsWith('DELETE FROM sessions')) sessions.delete(args[0]);
    else if (sql.startsWith('INSERT INTO presets')) presets.set(args[0],{id:args[0],name:args[1],spec:args[2],created_at:args[3]});
    else if (sql.startsWith('DELETE FROM presets')) presets.delete(args[0]);
    else throw new Error(sql);
    return {};
  }, async all() { if (sql.startsWith('SELECT id, name, spec')) return {results:[...presets.values()]}; throw new Error(sql); } }; } };
}
const origin = 'https://studio.example';
function request(path, method = 'GET', data, cookie, requestOrigin = origin) { return new Request(origin + path, {method,headers:{'Content-Type':'application/json', ...(method !== 'GET' ? {Origin:requestOrigin} : {}), ...(cookie ? {Cookie:cookie} : {})}, ...(data ? {body:JSON.stringify(data)} : {})}); }
function environment() { return { DB:database(), APP_PASSWORD:'a-secure-password-for-test', DEEPSEEK_API_KEY:'test', ASSETS:{fetch(){return new Response('asset');}} }; }
async function login(env) { const response = await worker.fetch(request('/api/login','POST',{password:env.APP_PASSWORD}),env); assert.equal(response.status,200); return response.headers.get('set-cookie').split(';')[0]; }

test('login, protected endpoints, origin and logout', async () => { const env = environment(); assert.equal((await worker.fetch(request('/api/presets'),env)).status,401); assert.equal((await worker.fetch(request('/api/login','POST',{password:'wrong'}),env)).status,401); assert.equal((await worker.fetch(request('/api/login','POST',{password:env.APP_PASSWORD},null,'https://evil.example'),env)).status,403); const token = await login(env); assert.equal((await worker.fetch(request('/api/session','GET',null,token),env)).status,200); assert.equal((await worker.fetch(request('/api/logout','POST',{},token),env)).status,200); assert.equal((await worker.fetch(request('/api/session','GET',null,token),env)).status,401); });

test('rate limits failed logins', async () => { const env = environment(); for(let i=0;i<10;i++) assert.equal((await worker.fetch(request('/api/login','POST',{password:'wrong'}),env)).status,401); assert.equal((await worker.fetch(request('/api/login','POST',{password:env.APP_PASSWORD}),env)).status,429); });

test('generates SVG with DeepSeek, revises it and persists a structured preset', async () => {
  const env = environment(), token = await login(env), originalFetch = globalThis.fetch; let call = 0;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="green"/></svg>';
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body); assert.equal(payload.model,'deepseek-flash'); call++;
    if (call === 2) { assert.ok(payload.messages.some(message => message.content.includes(svg))); assert.ok(payload.messages.some(message => message.content.includes('蓝色'))); }
    const content = call < 3 ? svg : JSON.stringify({title:'绿色小猫',constraints:['绿色'],prompt:'a green cat'});
    if (call < 3) assert.equal(payload.response_format, undefined);
    else assert.equal(payload.response_format.type, 'json_object');
    return Response.json({choices:[{message:{content}}]});
  };
  try {
    const history=[{role:'user',content:'一只绿色的猫'}];
    const response = await worker.fetch(request('/api/generate','POST',{history},token),env); assert.equal(response.status,200); assert.equal((await response.json()).svg,svg);
    const revised = await worker.fetch(request('/api/generate','POST',{history:[...history,{role:'assistant',content:'生成图标'},{role:'user',content:'改成蓝色'}],previousSvg:svg},token),env); assert.equal(revised.status,200);
    const save = await worker.fetch(request('/api/presets','POST',{name:'绿色猫',history,lastPrompt:'a green cat'},token),env); assert.equal(save.status,201); const saved = (await save.json()).preset;
    const list = await worker.fetch(request('/api/presets','GET',null,token),env); assert.deepEqual((await list.json()).presets[0].spec.constraints,['绿色']);
    await worker.fetch(request('/api/presets/'+saved.id,'DELETE',{},token),env); assert.equal((await (await worker.fetch(request('/api/presets','GET',null,token),env)).json()).presets.length,0);
  } finally { globalThis.fetch = originalFetch; }
});

test('rejects malformed model responses', async () => {
  const env = environment(), token = await login(env), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({choices:[{message:{content:'not an SVG'}}]});
  try { const response = await worker.fetch(request('/api/generate','POST',{history:[{role:'user',content:'图标'}]},token),env); assert.equal(response.status,400); assert.match((await response.json()).error,/未返回完整的 SVG/); } finally { globalThis.fetch = originalFetch; }
});
