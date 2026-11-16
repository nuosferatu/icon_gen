const $ = (selector) => document.querySelector(selector);
let history = [], presets = [], active = null, lastPrompt = '', lastSvg = '', imageUrl = '', busy = false;
function updateThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = dark ? 'Switch to Light Theme' : 'Switch to Dark Theme';
  const button = $('#theme-toggle');
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
  button.setAttribute('aria-pressed', String(dark));
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#191919' : '#f8f8f8');
}
$('#theme-toggle').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('icon-gen-theme', theme); } catch (_) {}
  updateThemeButton();
};
updateThemeButton();
function updateSidebarButton() {
  const expanded = document.documentElement.dataset.sidebar !== 'closed';
  const button = $('#sidebar-toggle');
  const label = expanded ? 'Collapse Sidebar' : 'Expand Sidebar';
  button.setAttribute('aria-expanded', String(expanded));
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}
$('#sidebar-toggle').onclick = () => {
  const state = document.documentElement.dataset.sidebar === 'closed' ? 'open' : 'closed';
  document.documentElement.dataset.sidebar = state;
  try { localStorage.setItem('icon-gen-sidebar', state); } catch (_) {}
  updateSidebarButton();
};
updateSidebarButton();

function toast(message, persistent = true) {
  const notice = document.createElement('div');
  notice.className = 'toast';
  notice.setAttribute('role', persistent ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.textContent = '×';
  close.onclick = () => notice.remove();
  notice.append(text, close);
  $('#toast-stack').append(notice);
  if (!persistent) setTimeout(() => notice.remove(), 4500);
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const data = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/api/login') showLogin(); throw new Error(data.error || 'Request failed'); }
  return data;
}
function showLogin() { $('#login').classList.remove('hidden'); $('#studio').classList.add('hidden'); $('#logout').classList.add('hidden'); $('#sidebar-toggle').classList.add('hidden'); }
async function showStudio() { $('#login').classList.add('hidden'); $('#studio').classList.remove('hidden'); $('#logout').classList.remove('hidden'); $('#sidebar-toggle').classList.remove('hidden'); await refreshPresets(); }
function setBusy(value) { busy = value; $('#chat-form button[type=submit]').disabled = value; $('#save').disabled = value || !lastPrompt; $('#new').disabled = value; $('#logout').disabled = value; document.querySelectorAll('.preset-load,.preset-delete').forEach(el => el.disabled = value); }
function renderPresets() {
  $('#preset-count').textContent = presets.length; const list = $('#presets'); list.replaceChildren();
  if (!presets.length) { const p = document.createElement('p'); p.className = 'empty-list'; p.textContent = 'No presets yet'; list.append(p); return; }
  for (const preset of presets) {
    const item = document.createElement('div'); item.className = 'preset-item' + (active?.id === preset.id ? ' selected' : '');
    const load = document.createElement('button'); load.className = 'preset-load'; load.textContent = preset.name; load.title = preset.name; load.disabled = busy;
    load.onclick = () => { if (history.length && !confirm('Loading a preset will clear the current chat. Continue?')) return; reset(preset); };
    const del = document.createElement('button'); del.className = 'preset-delete'; del.textContent = '×'; del.title = 'Delete Preset'; del.disabled = busy;
    del.onclick = async () => { if (!confirm(`Delete Preset ${preset.name}?`)) return; try { await api('/api/presets/' + encodeURIComponent(preset.id), {method:'DELETE'}); if (active?.id === preset.id) { active = null; updateActive(); } await refreshPresets(); toast('Preset deleted', false); } catch (e) { toast(e.message); } };
    item.append(load, del); list.append(item);
  }
}
async function refreshPresets() { presets = (await api('/api/presets')).presets; renderPresets(); }
function updateActive() { const el = $('#active-preset'); el.classList.toggle('hidden', !active); el.replaceChildren(); if (active) { const label = document.createElement('span'); label.textContent = `Current preset: ${active.name}`; const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'View Structured Details'; const pre = document.createElement('pre'); pre.textContent = JSON.stringify(active.spec, null, 2); details.append(summary, pre); el.append(label, details); } renderPresets(); }
// Prevent active content and external resources in a downloadable SVG.
function safeSvg(source) {
  if (typeof source !== 'string' || source.length > 50000) throw new Error('Invalid SVG size or content. Please try again.');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b|<\?/i.test(source)) throw new Error('SVG contains an unsupported XML declaration. Please try again.');
  if (!/^<svg\b[^>]*\bxmlns\s*=/i.test(source)) source = source.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    const detail = parseError.textContent.replace(/\s+/g, ' ').trim().slice(0, 240);
    throw new Error('Invalid SVG XML' + (detail ? ': ' + detail : '. Please try again.'));
  }
  if (doc.documentElement.localName !== 'svg' || doc.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('Invalid SVG root or namespace. Please try again.');
  for (const el of [doc.documentElement, ...doc.documentElement.querySelectorAll('*')]) {
    if (el.namespaceURI !== 'http://www.w3.org/2000/svg' || /^(script|foreignObject|iframe|object|embed|a)$/i.test(el.localName)) throw new Error('The SVG contains unsafe content. Please try again.');
    if (el.localName.toLowerCase() === 'style' && /@import|url\s*\((?!\s*['"]?#)/i.test(el.textContent)) throw new Error('The SVG contains external resources. Please try again.');
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.localName) || /(?:javascript:|data:|@import|expression\s*\()/i.test(attr.value) || (/url\s*\(/i.test(attr.value) && /url\s*\((?!\s*['"]?#)/i.test(attr.value)) || (/^(?:href|src)$/i.test(attr.localName) && !attr.value.startsWith('#'))) throw new Error('The SVG contains unsafe content. Please try again.');
    }
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}
function reset(preset = null) { history = []; active = preset; lastPrompt = ''; lastSvg = ''; if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = ''; $('#messages').replaceChildren(); $('#summary-content').textContent = ''; $('#summary-content').classList.add('hidden'); $('#summary-status').textContent = 'No summary yet'; $('#image').classList.add('hidden'); $('.empty-image').classList.remove('hidden'); $('#download').classList.add('hidden'); $('#save').disabled = true; updateActive(); }
function addMessage(role, content) { const el = document.createElement('div'); el.className = 'bubble ' + role; el.textContent = content; $('#messages').append(el); $('#messages').scrollTop = $('#messages').scrollHeight; return el; }
$('#login-form').onsubmit = async e => { e.preventDefault(); const button = e.target.querySelector('button'); button.disabled = true; try { await api('/api/login', { method:'POST', body: {password:$('#password').value} }); $('#password').value = ''; await showStudio(); } catch (err) { toast(err.message); } finally { button.disabled = false; } };
$('#logout').onclick = async () => { try { await api('/api/logout',{method:'POST',body:{}}); reset(); showLogin(); } catch(e) { toast(e.message); } };
$('#new').onclick = () => { if (history.length && !confirm('Starting a new chat will clear the current chat. Continue?')) return; reset(); };
$('#message').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!busy && !event.repeat) $('#chat-form').requestSubmit();
});
$('#chat-form').onsubmit = async e => {
  e.preventDefault();
  if (busy) return;
  const content = $('#message').value.trim();
  if (!content) return;
  const draft = [...history, {role:'user', content}];
  if (draft.length > 40) { toast('Chat limit reached. Save a preset and start a new chat.'); return; }
  setBusy(true);
  const pending = addMessage('user', content);
  $('#message').value = '';
  $('#message').focus();
  const loading = addMessage('assistant','Generating image…');
  const previousSummaryStatus = $('#summary-status').textContent;
  $('#summary-status').textContent = 'Updating summary…';
  try {
    const result = await api('/api/summarize',{method:'POST',body:{history:draft,preset:active?.spec || null}});
    const data = await api('/api/generate',{method:'POST',body:{history:draft,preset:active?.spec || null,previousSvg:lastSvg || null,requirements:result.summary}});
    const svg = safeSvg(data.svg);
    const nextUrl = URL.createObjectURL(new Blob([svg], {type:'image/svg+xml'}));
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = nextUrl; lastSvg = svg;
    loading.textContent = data.reply;
    history = [...draft,{role:'assistant',content:data.reply}];
    lastPrompt = data.prompt;
    $('#image').src = imageUrl;
    $('#image').classList.remove('hidden');
    $('.empty-image').classList.add('hidden');
    $('#download').href = imageUrl;
    $('#download').classList.remove('hidden');
    $('#summary-content').textContent = JSON.stringify(result.summary, null, 2);
    $('#summary-content').classList.remove('hidden');
    $('#summary-status').textContent = '';
  } catch (error) {
    $('#summary-status').textContent = previousSummaryStatus;
    pending.remove(); loading.remove();
    const nextDraft = $('#message').value;
    $('#message').value = content + (nextDraft ? '\n' + nextDraft : '');
    toast(error.message);
  } finally { setBusy(false); }
};
$('#save').onclick = async () => { if (busy || !lastPrompt) return; const name = prompt('Name this preset:'); if (!name?.trim()) return; setBusy(true); try { await api('/api/presets',{method:'POST',body:{name:name.trim(),history,preset:active?.spec || null,lastPrompt}}); await refreshPresets(); toast('Preset saved', false); } catch(e) { toast(e.message); } finally { setBusy(false); } };
(async () => { try { await api('/api/session'); await showStudio(); } catch { showLogin(); } })();
