const $ = (selector) => document.querySelector(selector);
let history = [], presets = [], active = null, lastPrompt = '', lastSvg = '', imageUrl = '', busy = false;
const toast = (message) => { const el = $('#toast'); el.textContent = message; el.classList.remove('hidden'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.add('hidden'), 4500); };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/api/login') showLogin(); throw new Error(data.error || '请求失败'); }
  return data;
}
function showLogin() { $('#login').classList.remove('hidden'); $('#studio').classList.add('hidden'); $('#logout').classList.add('hidden'); }
async function showStudio() { $('#login').classList.add('hidden'); $('#studio').classList.remove('hidden'); $('#logout').classList.remove('hidden'); await refreshPresets(); }
function setBusy(value) { busy = value; $('#chat-form button[type=submit]').disabled = value; $('#save').disabled = value || !lastPrompt; $('#message').disabled = value; $('#new').disabled = value; document.querySelectorAll('.preset-load,.preset-delete').forEach(el => el.disabled = value); }
function renderPresets() {
  $('#preset-count').textContent = presets.length; const list = $('#presets'); list.replaceChildren();
  if (!presets.length) { const p = document.createElement('p'); p.className = 'empty-list'; p.textContent = '暂无预设'; list.append(p); return; }
  for (const preset of presets) {
    const item = document.createElement('div'); item.className = 'preset-item' + (active?.id === preset.id ? ' selected' : '');
    const load = document.createElement('button'); load.className = 'preset-load'; load.textContent = preset.name; load.title = preset.name; load.disabled = busy;
    load.onclick = () => { if (history.length && !confirm('加载预设会清空当前对话，继续吗？')) return; reset(preset); };
    const del = document.createElement('button'); del.className = 'preset-delete'; del.textContent = '×'; del.title = '删除预设'; del.disabled = busy;
    del.onclick = async () => { if (!confirm(`删除预设“${preset.name}”？`)) return; try { await api('/api/presets/' + encodeURIComponent(preset.id), {method:'DELETE'}); if (active?.id === preset.id) { active = null; updateActive(); } await refreshPresets(); toast('预设已删除'); } catch (e) { toast(e.message); } };
    item.append(load, del); list.append(item);
  }
}
async function refreshPresets() { presets = (await api('/api/presets')).presets; renderPresets(); }
function updateActive() { const el = $('#active-preset'); el.classList.toggle('hidden', !active); el.replaceChildren(); if (active) { const label = document.createElement('span'); label.textContent = `当前预设：${active.name}`; const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '查看结构化信息'; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(active.spec, null, 2); details.append(summary, pre); el.append(label, details); } renderPresets(); }
// Parse model output as XML and copy only safe SVG elements and attributes.
function safeSvg(source) {
  if (typeof source !== 'string' || source.length > 50000 || /<!/i.test(source)) throw new Error('生成的 SVG 格式无效，请重试');
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg' || doc.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('生成的 SVG 格式无效，请重试');
  const elements = new Set(['svg','g','defs','path','rect','circle','ellipse','line','polyline','polygon','linearGradient','radialGradient','stop','title','desc']);
  const attributes = new Set(['xmlns','viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','fill','fill-opacity','fill-rule','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-opacity','stroke-dasharray','stroke-dashoffset','opacity','transform','id','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','fx','fy','fr','preserveAspectRatio','clip-rule']);
  for (const el of [doc.documentElement, ...doc.documentElement.querySelectorAll('*')]) {
    if (el.namespaceURI !== 'http://www.w3.org/2000/svg' || !elements.has(el.localName)) throw new Error('生成的 SVG 包含不支持的元素，请重试');
    for (const attr of [...el.attributes]) {
      if (!attributes.has(attr.name) || /(?:javascript:|https?:|data:|@import|expression\s*\()/i.test(attr.value) || (/url\s*\(/i.test(attr.value) && !/^url\(#[\w-]+\)$/.test(attr.value.trim()))) throw new Error('生成的 SVG 包含不支持的属性，请重试');
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}
function reset(preset = null) { history = []; active = preset; lastPrompt = ''; lastSvg = ''; if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = ''; $('#messages').replaceChildren(); $('#image').classList.add('hidden'); $('.empty-image').classList.remove('hidden'); $('#download').classList.add('hidden'); $('#save').disabled = true; updateActive(); }
function addMessage(role, content) { const el = document.createElement('div'); el.className = 'bubble ' + role; el.textContent = content; $('#messages').append(el); $('#messages').scrollTop = $('#messages').scrollHeight; return el; }
$('#login-form').onsubmit = async e => { e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true; try { await api('/api/login', { method:'POST', body: {password:$('#password').value} }); $('#password').value = ''; await showStudio(); } catch (err) { toast(err.message); } finally { button.disabled = false; } };
$('#logout').onclick = async () => { try { await api('/api/logout',{method:'POST',body:{}}); reset(); showLogin(); } catch(e) { toast(e.message); } };
$('#new').onclick = () => { if (history.length && !confirm('开始新创作会清空当前对话，继续吗？')) return; reset(); };
$('#chat-form').onsubmit = async e => { e.preventDefault(); if (busy) return; const content = $('#message').value.trim(); if (!content) return; const draft = [...history, {role:'user', content}]; if (draft.length > 40) { toast('当前对话已达到长度上限，请先保存预设并开启新创作'); return; } setBusy(true); const pending = addMessage('user', content); $('#message').value = ''; const loading = addMessage('assistant','正在构思并生成画面，请稍候…'); try { const data = await api('/api/generate',{method:'POST',body:{history:draft,preset:active?.spec || null,previousSvg:lastSvg || null}}); const svg = safeSvg(data.svg); const nextUrl = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml'})); if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = nextUrl; lastSvg = svg; loading.textContent = data.reply; history = [...draft,{role:'assistant',content:data.reply}]; lastPrompt = data.prompt; $('#image').src = imageUrl; $('#image').classList.remove('hidden'); $('.empty-image').classList.add('hidden'); $('#download').href = $('#image').src; $('#download').classList.remove('hidden'); } catch(err) { pending.remove(); loading.remove(); $('#message').value = content; toast(err.message); } finally { setBusy(false); } };
$('#save').onclick = async () => { if (busy || !lastPrompt) return; const name = prompt('给这个预设起个名字：'); if (!name?.trim()) return; setBusy(true); try { await api('/api/presets',{method:'POST',body:{name:name.trim(),history,preset:active?.spec || null,lastPrompt}}); await refreshPresets(); toast('预设已保存'); } catch(e) { toast(e.message); } finally { setBusy(false); } };
(async () => { try { await api('/api/session'); await showStudio(); } catch { showLogin(); } })();
