const $ = (selector) => document.querySelector(selector);
let history = [], presets = [], active = null, lastPrompt = '', busy = false;
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
  if (!presets.length) { const p = document.createElement('p'); p.className = 'empty-list'; p.textContent = '还没有预设。满意的作品可以保存到这里。'; list.append(p); return; }
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
function updateActive() { const el = $('#active-preset'); el.classList.toggle('hidden', !active); el.replaceChildren(); if (active) { const label = document.createElement('span'); label.textContent = `✳  正在使用预设：${active.name}  ·  后续描述会在此基础上调整`; const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = '查看结构化信息'; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(active.spec, null, 2); details.append(summary, pre); el.append(label, details); } renderPresets(); }
function reset(preset = null) { history = []; active = preset; lastPrompt = ''; $('#messages').innerHTML = '<div class="empty-chat"><div class="sparkle">✳</div><strong>你的创意，从这里开始</strong><p>试试描述主体、风格或色彩，<br>也可以在生成后继续调整。</p><div class="suggestions"><button data-suggestion="一只圆滚滚的橘猫，手绘水彩风格，柔和的奶油色背景">水彩小猫 ↗</button><button data-suggestion="极简咖啡店标志，深绿色和米白色，干净的矢量图形">咖啡店标志 ↗</button></div></div>'; $('#image').classList.add('hidden'); $('.empty-image').classList.remove('hidden'); $('#download').classList.add('hidden'); $('#image-title').textContent = '等待创作'; $('#image-subtitle').textContent = 'YOUR CANVAS AWAITS'; $('#save').disabled = true; updateActive(); }
function addMessage(role, content) { $('.empty-chat')?.remove(); const el = document.createElement('div'); el.className = 'bubble ' + role; el.textContent = content; $('#messages').append(el); $('#messages').scrollTop = $('#messages').scrollHeight; return el; }
$('#login-form').onsubmit = async e => { e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true; try { await api('/api/login', { method:'POST', body: {password:$('#password').value} }); $('#password').value = ''; await showStudio(); } catch (err) { toast(err.message); } finally { button.disabled = false; } };
$('#logout').onclick = async () => { try { await api('/api/logout',{method:'POST',body:{}}); reset(); showLogin(); } catch(e) { toast(e.message); } };
$('#new').onclick = () => { if (history.length && !confirm('开始新创作会清空当前对话，继续吗？')) return; reset(); };
$('#messages').onclick = e => { const value = e.target.dataset.suggestion; if (value) { $('#message').value = value; $('#message').focus(); } };
$('#chat-form').onsubmit = async e => { e.preventDefault(); if (busy) return; const content = $('#message').value.trim(); if (!content) return; const draft = [...history, {role:'user', content}]; if (draft.length > 40) { toast('当前对话已达到长度上限，请先保存预设并开启新创作'); return; } setBusy(true); const pending = addMessage('user', content); $('#message').value = ''; const loading = addMessage('assistant','正在构思并生成画面，请稍候…'); try { const data = await api('/api/generate',{method:'POST',body:{history:draft,preset:active?.spec || null}}); loading.textContent = data.reply; history = [...draft,{role:'assistant',content:data.reply}]; lastPrompt = data.prompt; $('#image').src = 'data:image/jpeg;base64,' + data.image; $('#image').classList.remove('hidden'); $('.empty-image').classList.add('hidden'); $('#download').href = $('#image').src; $('#download').classList.remove('hidden'); $('#image-title').textContent = '你的新画面'; $('#image-subtitle').textContent = 'GENERATED IMAGE'; } catch(err) { pending.remove(); loading.remove(); $('#message').value = content; toast(err.message); } finally { setBusy(false); } };
$('#save').onclick = async () => { if (busy || !lastPrompt) return; const name = prompt('给这个预设起个名字：'); if (!name?.trim()) return; setBusy(true); try { await api('/api/presets',{method:'POST',body:{name:name.trim(),history,preset:active?.spec || null,lastPrompt}}); await refreshPresets(); toast('预设已保存，下次可以从左侧加载'); } catch(e) { toast(e.message); } finally { setBusy(false); } };
(async () => { try { await api('/api/session'); await showStudio(); } catch { showLogin(); } })();
