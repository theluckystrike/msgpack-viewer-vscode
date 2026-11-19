// MsgPack Viewer webview: the tree of values (children loaded on demand, 500 at a time), the details of the selected
// value with its bytes, the JSON view, search and the Read as switch. Data comes from the extension host; this page
// makes no network request (CSP default-src 'none') and sets no inline style attributes (styles go through the style object).
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const post = (m) => vscode.postMessage(m);
  const k = (id) => String(id);
  const num = (n) => Number(n).toLocaleString('en-US');

  let data = null;
  let roots = [];
  const kids = new Map(); // id -> { rows, more, total, err }
  const nodes = new Map(); // id -> row
  const open = new Set();
  let sel = null;
  let details = null;
  let mode = 'tree';
  let first = true;
  let searchTimer = null;

  function footer() { const f = $('zovo-footer'); if (f && !$('footer').childElementCount) $('footer').innerHTML = f.innerHTML; }
  function status(t) { $('statusText').textContent = t; }
  function banner(html) { const m = $('msg'); m.innerHTML = html; m.hidden = !html; }
  const remember = (rows) => { for (const r of rows) nodes.set(k(r.id), r); };

  function init(m) {
    data = m;
    footer();
    document.body.dataset.fmt = m.fmt;
    const sel0 = $('readAs');
    sel0.innerHTML = m.formats.map(([id, name]) => `<option value="${esc(id)}"${id === m.fmt ? ' selected' : ''}>${esc(name)}</option>`).join('');
    kids.clear(); nodes.clear(); open.clear(); sel = null; details = null;
    $('results').hidden = true; $('results').innerHTML = ''; $('count').textContent = '';
    if (m.state !== 'ready') {
      document.body.dataset.state = m.state;
      $('fmt').textContent = `${m.fmtName}, ${m.sizeText}`;
      roots = [];
      $('tree').innerHTML = '';
      $('details').innerHTML = '';
      const hex = m.hex && m.state !== 'empty' ? ` <button class="tb" id="mHex">Open in ${esc(m.hex)}</button>` : '';
      banner(`<p>${esc(m.error)}</p>${hex ? `<p>${hex}</p>` : ''}`);
      if ($('mHex')) $('mHex').onclick = () => post({ type: 'openHex' });
      ['search', 'collapse', 'modeJson'].forEach((id) => { $(id).disabled = true; });
      status(m.error);
      return;
    }
    ['search', 'collapse', 'modeJson'].forEach((id) => { $(id).disabled = false; });
    document.body.dataset.state = 'ready';
    document.body.dataset.multi = m.multi ? '1' : '0';
    $('fmt').textContent = `${m.fmtName}, ${m.multi ? `${num(m.count)} ${m.count === 1 ? 'value' : 'values'}, ` : ''}${m.sizeText}`;
    const hexBtn = m.hex ? ` <button class="tb" id="mHex">Open in ${esc(m.hex)}</button>` : '';
    const hint = m.hint ? `<p id="hint">${esc(m.hint)} <button class="tb" id="mText">Open as Text</button></p>` : '';
    banner(hint + (m.banner ? `<p id="bad">${esc(m.banner)}${hexBtn}</p>${m.count === 0 && !m.hint ? '<p class="note">If this is another format, pick it under Read as.</p>' : ''}` : ''));
    if ($('mHex')) $('mHex').onclick = () => post({ type: 'openHex' });
    if ($('mText')) $('mText').onclick = () => post({ type: 'openText' });
    roots = m.rows;
    remember(roots);
    kids.set('0', { rows: m.rows, more: m.more, err: null });
    // one value: open it; a stream: open the first one
    if (roots.length && roots[0].kids && !roots[0].broken) open.add(k(roots[0].id));
    const openFirst = roots.length && roots[0].kids && !roots[0].broken;
    status(`${m.multi ? `${num(m.count)} ${m.count === 1 ? 'value' : 'values'} one after another` : '1 value'} in ${m.sizeText}. Read-only view${m.banner ? '; the file has bad data, see above' : ''}.`);
    render();
    if (openFirst) post({ type: 'children', id: roots[0].id, start: 0 });
    if (m.keep && m.keep.chain) post({ type: 'reveal', chain: m.keep.chain });
    else if (roots.length) select(roots[0].id, false);
    if (mode === 'json') requestJson();
    if (first) { first = false; post({ type: 'rendered' }); }
  }

  function rowHtml(r) {
    const isOpen = open.has(k(r.id));
    const tw = r.kids ? (isOpen ? '▾' : '▸') : '';
    const cls = ['trow', r.id === sel ? 'sel' : '', r.broken ? 'broken' : '', r.bad ? 'bad' : ''].filter(Boolean).join(' ');
    const sz = r.size >= 0 ? num(r.size) : '?';
    return `<div class="${cls}" data-id="${r.id}" data-depth="${r.depth}" role="treeitem" aria-expanded="${r.kids ? String(isOpen) : ''}">`
      + `<span class="k"><span class="tw">${tw}</span><span class="nm ${r.keyKind}">${esc(r.key)}</span>${r.broken ? ' <span class="warn" title="Damaged data inside">⚠</span>' : ''}</span>`
      + `<span class="ty">${esc(r.type)}</span><span class="off" title="0x${r.off.toString(16).toUpperCase()}">${num(r.off)}</span><span class="sz">${sz}</span>`
      + `<span class="pv">${esc(r.preview)}</span></div>`;
  }
  function renderRows(list, out) {
    for (const r of list) {
      out.push(rowHtml(r));
      if (r.kids && open.has(k(r.id))) {
        const c = kids.get(k(r.id));
        if (!c) { out.push(`<div class="trow note" data-depth="${r.depth + 1}"><span class="muted">Reading...</span></div>`); continue; }
        renderRows(c.rows, out);
        if (c.more) out.push(`<div class="trow more" data-parent="${r.id}" data-depth="${r.depth + 1}"><a href="#" class="moreLink">Show ${num(Math.min(data.page, c.total - c.rows.length))} more (${num(c.total - c.rows.length)} not shown yet)</a></div>`);
        if (c.err) out.push(`<div class="trow errrow" data-depth="${r.depth + 1}"><span class="err">Bad data at byte ${num(c.err.off)} (0x${c.err.off.toString(16).toUpperCase()}): ${esc(c.err.message)}</span></div>`);
      }
    }
  }
  function render() {
    const out = [];
    renderRows(roots, out);
    const top = kids.get('0');
    if (top && top.more) out.push(`<div class="trow more" data-parent="0" data-depth="0"><a href="#" class="moreLink">Show ${num(Math.min(data.page, data.count - roots.length))} more (${num(data.count - roots.length)} not shown yet)</a></div>`);
    $('tree').innerHTML = out.join('');
    for (const el of $('tree').querySelectorAll('.trow')) {
      const d = Number(el.dataset.depth || 0);
      const kEl = el.querySelector('.k') || el.firstElementChild;
      if (kEl) kEl.style.paddingLeft = `${4 + d * 16}px`;
    }
  }

  function toggle(id) {
    const key = k(id);
    const r = nodes.get(key);
    if (!r || !r.kids) return;
    if (open.has(key)) open.delete(key);
    else { open.add(key); if (!kids.has(key)) post({ type: 'children', id: r.id, start: 0 }); }
    render();
  }
  function select(id, scroll = true) {
    sel = Number(id);
    for (const el of $('tree').querySelectorAll('.trow.sel')) el.classList.remove('sel');
    const el = $('tree').querySelector(`.trow[data-id="${sel}"]`);
    if (el) { el.classList.add('sel'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
    post({ type: 'select', id: sel });
    if (mode === 'json') requestJson();
  }

  function showDetails(dt) {
    details = dt;
    const pro = document.body.dataset.pro === '1';
    const facts = [['Path', dt.path], ['Type', dt.type], ['Offset', `byte ${num(dt.off)} (0x${dt.off.toString(16).toUpperCase()})${dt.elemOff >= 0 ? `; its element starts at byte ${num(dt.elemOff)}` : ''}`],
      ['Size', dt.size >= 0 ? `${num(dt.size)} ${dt.size === 1 ? 'byte' : 'bytes'}${dt.hdr ? ` (${dt.hdr} of header)` : ''}` : 'unknown (damaged)'], ...dt.facts];
    const editBtn = dt.editable && pro ? ' <button class="tb pro" id="editValue" title="Zovo Pro: change this value and save it back to the file in the same format">Edit value (Pro)</button>' : '';
    $('details').innerHTML = `<h2 id="dPath">${esc(dt.path)}</h2>
<dl id="dFacts">${facts.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>
<h3>Value</h3><pre id="dValue" class="val">${esc(dt.value)}</pre>
<p class="row"><button class="tb" id="copyValue">Copy value</button> <button class="tb" id="copyPath">Copy path</button> <button class="tb" id="copyJson">Copy as JSON</button>${editBtn}</p>
<h3>Bytes${dt.hexMore ? ' (first 256)' : ''}</h3><pre id="dHex" class="hex">${esc(dt.hex)}</pre>`;
    $('copyValue').onclick = () => post({ type: 'copy', what: 'value', id: dt.id });
    $('copyPath').onclick = () => post({ type: 'copy', what: 'path', id: dt.id });
    $('copyJson').onclick = () => post({ type: 'copy', what: 'json', id: dt.id });
    if ($('editValue')) $('editValue').onclick = () => post({ type: 'pro', tool: 'edit', id: dt.id });
  }

  function requestJson() { $('jsonNote').textContent = 'Reading...'; post({ type: 'json', id: sel === null ? 0 : sel }); }
  function setMode(m) {
    mode = m;
    $('modeTree').classList.toggle('sel', m === 'tree');
    $('modeJson').classList.toggle('sel', m === 'json');
    $('tree').hidden = m !== 'tree';
    $('treeHead').hidden = m !== 'tree';
    $('json').hidden = m !== 'json';
    document.body.dataset.mode = m;
    if (m === 'json') requestJson();
  }

  function showResults(m) {
    const box = $('results');
    if (!m.q) { box.hidden = true; box.innerHTML = ''; $('count').textContent = ''; return; }
    $('count').textContent = `${m.hits.length}${m.more ? '+' : ''} ${m.hits.length === 1 ? 'match' : 'matches'}`;
    box.hidden = false;
    box.innerHTML = m.hits.length
      ? `<ul id="hits">${m.hits.map((h, i) => `<li><a href="#" data-i="${i}">${esc(h.path)}</a> <span class="muted">${esc(h.preview)}</span></li>`).join('')}</ul>${m.more ? '<p class="muted">More matches than shown; type more of the word.</p>' : ''}`
      : '<p class="muted">No key or value contains this text.</p>';
    box.onclick = (e) => {
      const a = e.target.closest('a[data-i]');
      if (!a) return;
      e.preventDefault();
      post({ type: 'reveal', chain: m.hits[Number(a.dataset.i)].chain });
    };
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'init': init(m); break;
      case 'children': {
        const key = k(m.id);
        const prev = kids.get(key);
        const rows = m.start && prev ? prev.rows.slice(0, m.start).concat(m.rows) : m.rows;
        remember(m.rows);
        kids.set(key, { rows, more: m.more, total: m.total, err: m.err });
        if (key === '0') { roots = rows; }
        render();
        break;
      }
      case 'details': if (m.details.id === sel) showDetails(m.details); break;
      case 'json': if (m.id === (sel === null ? 0 : sel)) { $('jsonText').textContent = m.error ? '' : m.text; $('jsonNote').textContent = m.error ? m.error : m.truncated ? 'The first 2 MB are shown. Copy JSON copies all of it.' : `${(nodes.get(k(m.id)) || {}).path || 'The whole file'}`; } break;
      case 'results': showResults(m); break;
      case 'chain': {
        for (const lv of m.levels) {
          remember(lv.rows);
          kids.set(k(lv.id), { rows: lv.rows, more: lv.more, total: lv.total, err: lv.err });
          if (k(lv.id) === '0') roots = lv.rows;
          open.add(k(lv.id));
        }
        render();
        select(m.target);
        break;
      }
      case 'copied': status(`Copied ${m.what} (${num(m.chars)} ${m.chars === 1 ? 'character' : 'characters'}).`); break;
      case 'note': status(m.text); break;
      default:
    }
  });

  $('tree').addEventListener('click', (e) => {
    const more = e.target.closest('.trow.more');
    if (more) { e.preventDefault(); const pid = more.dataset.parent; const c = kids.get(k(pid)); post({ type: 'children', id: Number(pid), start: c ? c.rows.length : 0 }); return; }
    const row = e.target.closest('.trow[data-id]');
    if (!row) return;
    if (e.target.closest('.tw')) { toggle(row.dataset.id); return; }
    select(row.dataset.id, false);
  });
  $('tree').addEventListener('dblclick', (e) => { const row = e.target.closest('.trow[data-id]'); if (row) toggle(row.dataset.id); });
  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    if (sel === null || mode !== 'tree') return;
    const rows = [...$('tree').querySelectorAll('.trow[data-id]')];
    const i = rows.findIndex((r) => Number(r.dataset.id) === sel);
    if (e.key === 'ArrowDown' && i + 1 < rows.length) { select(rows[i + 1].dataset.id); e.preventDefault(); }
    else if (e.key === 'ArrowUp' && i > 0) { select(rows[i - 1].dataset.id); e.preventDefault(); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Enter') {
      const r = nodes.get(k(sel));
      if (r && r.kids && ((e.key === 'ArrowRight') !== open.has(k(sel)) || e.key === 'Enter')) toggle(sel);
      e.preventDefault();
    }
  });
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => post({ type: 'search', q: $('search').value }), 300); });
  $('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); post({ type: 'search', q: $('search').value }); } });
  $('collapse').addEventListener('click', () => { open.clear(); render(); });
  $('modeTree').addEventListener('click', () => setMode('tree'));
  $('modeJson').addEventListener('click', () => setMode('json'));
  $('copyAllJson').addEventListener('click', () => post({ type: 'copy', what: 'json', id: sel === null ? 0 : sel }));
  $('readAs').addEventListener('change', () => post({ type: 'readAs', fmt: $('readAs').value }));
  post({ type: 'ready' });
}());
