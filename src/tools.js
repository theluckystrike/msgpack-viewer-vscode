'use strict';
// The four Zovo Pro tools: Convert to JSON and from JSON, Edit a value and save, Compare two files, Batch convert a
// folder to JSON. Each asks pro.allowed() on every click and calls pro.produced() only after its result is there
// (the file written, the comparison or the batch results drawn in their panel), so Escape, Cancel or an error never
// uses a free try. Everything runs on this computer; files are read and written through VS Code's file system API.
const vscode = require('vscode');
const path = require('path');
const C = require('./core/common');
const W = require('./core/walk');
const V = require('./core/value');
const { fmtOfName, NAMES, parseEdit, editText } = require('./core/view');
const { loadFile, VIEW } = require('./editor');
const { panelHtml } = require('./html');
const support = require('./support');

const PREFIX = 'msgpackViewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = (uri) => path.posix.basename(uri.path);
const stem = (uri) => base(uri).replace(/\.[^.]+$/, '');
const EXT = { msgpack: 'msgpack', cbor: 'cbor', bson: 'bson' };
const BIN_RE = /\.(msgpack|mpk|cbor|bson)$/i;
const JSON_RE = /\.(json|jsonl|ndjson)$/i;
const FILTERS = { 'MessagePack, CBOR, BSON': ['msgpack', 'mpk', 'cbor', 'bson'], JSON: ['json', 'jsonl', 'ndjson'], 'All files': ['*'] };
const OPEN_MAX = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_FILES = 5000;
const n = (count, one, many) => `${Number(count).toLocaleString('en-US')} ${count === 1 ? one : many}`;
const sameFile = (a, b) => a && b && a.toString() === b.toString();
function sibling(uri, name) { return vscode.Uri.joinPath(uri, '..', name); }
async function writeBytes(uri, bytes) { await vscode.workspace.fs.writeFile(uri, bytes instanceof Uint8Array ? bytes : Buffer.from(bytes, 'utf8')); }
async function exists(uri) { try { await vscode.workspace.fs.stat(uri); return true; } catch (e) { return false; } }
const errText = (e) => (e instanceof C.DecodeError ? `bad data at ${C.at(e.offset)}: ${e.message}` : String((e && e.message) || e));

function createTools({ context, viewer, pro, reach }) {
  const panels = {};

  function openPanel(kind, title) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    const old = panels[kind];
    if (old && !old.disposed) old.panel.dispose();
    const panel = vscode.window.createWebviewPanel(`${PREFIX}.${kind}`, title, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
      enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)),
    });
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title, head: reach ? (x) => reach.headHtml(x) : undefined, showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    let readyFn;
    const p = { panel, kind, disposed: false, actions: null, shown: null };
    p.ready = new Promise((r) => { readyFn = r; });
    p.post = (msg) => { try { const r = panel.webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } };
    p.show = async (o) => { await p.ready; p.post({ type: 'show', ...o }); };
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try {
        if (m.type === 'ready') readyFn();
        else if (m.type === 'shown') { if (p.shown) { const f = p.shown; p.shown = null; await f(m); } }
        else if (m.type === 'action' && p.actions) await p.actions(m.id, m);
      } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); }
    });
    panel.onDidDispose(() => { p.disposed = true; if (panels[kind] === p) delete panels[kind]; });
    panels[kind] = p;
    return p;
  }

  function activeJson() {
    const ed = vscode.window.activeTextEditor;
    if (ed && (JSON_RE.test(ed.document.uri.path) || /^json(l|c)?$/.test(ed.document.languageId || ''))) return ed.document.uri;
    return undefined;
  }

  /** The file a tool works on: the clicked one, else the active viewer's file (or JSON editor), else a dialog. */
  async function targetFile(arg, title, { json = false } = {}) {
    if (arg && arg.scheme) return arg;
    if (viewer.active) return viewer.active.uri;
    if (json) { const j = activeJson(); if (j) return j; }
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Choose', title, filters: FILTERS });
    return r && r[0];
  }

  /** { fmt, values, name, count } of a binary file (the open view's format choice wins). Throws with the byte offset. */
  async function valuesOf(uri) {
    const d = viewer.docFor(uri);
    let s = d && d.session;
    if (!s) {
      const fmt = viewer.overrides.get(uri.toString()) || fmtOfName(base(uri)) || 'msgpack';
      const r = await loadFile(uri, fmt);
      if (!r.session) throw new Error(`${base(uri)}: ${r.error}`);
      s = r.session;
    }
    try {
      return { fmt: s.fmt, values: W.decodeAll(s.fmt, s.buf), name: base(uri) };
    } catch (e) { throw new Error(`${base(uri)} could not be read as ${NAMES[s.fmt]}: ${errText(e)}`); }
  }

  async function openResult(dest, size, binFmt) {
    if (binFmt) await vscode.commands.executeCommand('vscode.openWith', dest, VIEW, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    else if (size <= OPEN_MAX) { const td = await vscode.workspace.openTextDocument(dest); await vscode.window.showTextDocument(td, { viewColumn: vscode.ViewColumn.Beside, preview: true }); }
  }

  // ---------- 1. Convert to JSON and from JSON ----------
  async function convert(arg, extra = {}) {
    if (!(await pro.allowed('convert', arg))) return undefined;
    const uri = await targetFile(arg, 'Convert: choose a MessagePack, CBOR, BSON or JSON file', { json: true });
    if (!uri) return undefined;
    const td = (vscode.workspace.textDocuments || []).find((t) => t.uri.toString() === uri.toString());
    const isJson = JSON_RE.test(uri.path) || (!BIN_RE.test(uri.path) && td && /^json(l|c)?$/.test(td.languageId || ''));
    return isJson ? fromJson(uri, td, extra) : toOther(uri, extra);
  }

  async function fromJson(uri, td, extra) {
    const text = td ? td.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const jsonl = /\.(jsonl|ndjson)$/i.test(uri.path) || (td && td.languageId === 'jsonl');
    let values;
    try { values = V.fromJsonText(text, { jsonl }); } catch (e) { vscode.window.showErrorMessage(`${base(uri)} is not valid JSON${jsonl ? ' Lines' : ''}: ${e.message}.`); return undefined; }
    if (!values.length) { vscode.window.showErrorMessage(`${base(uri)} holds no JSON value.`); return undefined; }
    const items = [
      { label: 'MessagePack', description: '.msgpack', id: 'msgpack' },
      { label: 'CBOR', description: '.cbor', id: 'cbor' },
      { label: 'BSON', description: '.bson (documents only)', id: 'bson' },
    ];
    let fmt = extra.format;
    if (!fmt) {
      const pick = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, title: `Convert ${base(uri)} to...`, placeHolder: 'Typed JSON wrappers such as {"$date": ...} or {"$oid": ...} become the matching types' });
      if (!pick) return undefined;
      fmt = pick.id;
    }
    if (!EXT[fmt]) return undefined;
    // one JSON array: one value, or a stream with one value per item (BSON: always one document per item)
    if (!jsonl && values.length === 1 && values[0].t === 'arr') {
      let split = extra.split;
      if (fmt === 'bson') split = true;
      else if (split === undefined) {
        const pick = await vscode.window.showQuickPick([
          { label: 'One value: the whole array', id: false },
          { label: `${n(values[0].v.length, 'value', 'values')}, one per array item`, description: 'one after another, as a stream', id: true },
        ], { ignoreFocusOut: true, title: `Convert ${base(uri)} to ${NAMES[fmt]}`, placeHolder: 'The file holds one JSON array' });
        if (!pick) return undefined;
        split = pick.id;
      }
      if (split) values = values[0].v;
    }
    let bytes;
    try { bytes = W.encodeAll(fmt, values.map((v) => V.lower(v, fmt))); } catch (e) { vscode.window.showErrorMessage(`Cannot write ${NAMES[fmt]}: ${e.message}`); return undefined; }
    const dest = extra.dest || await vscode.window.showSaveDialog({ defaultUri: sibling(uri, `${stem(uri)}.${EXT[fmt]}`), filters: { [NAMES[fmt]]: [EXT[fmt]] }, title: `Save as ${NAMES[fmt]}` });
    if (!dest) return undefined;
    if (sameFile(dest, uri)) { vscode.window.showErrorMessage('Choose another file name: the conversion never writes over the file it reads.'); return undefined; }
    await writeBytes(dest, bytes);
    if (fmtOfName(base(dest)) !== fmt) viewer.overrides.set(dest.toString(), fmt);
    await openResult(dest, bytes.length, fmt);
    vscode.window.setStatusBarMessage(`Saved ${base(dest)}: ${n(values.length, 'value', 'values')}, ${n(bytes.length, 'byte', 'bytes')} of ${NAMES[fmt]}`, 8000);
    await pro.produced('convert');
    return { dest, format: fmt, values: values.length, size: bytes.length };
  }

  async function toOther(uri, extra) {
    let r;
    try { r = await valuesOf(uri); } catch (e) { vscode.window.showErrorMessage(e.message); return undefined; }
    const multi = r.values.length !== 1;
    const items = [
      { label: 'JSON, plain', description: multi ? `${n(r.values.length, 'value', 'values')} as one JSON array; readable` : 'readable: binary as base64, dates as ISO text', id: 'plain' },
      { label: 'JSON, typed', description: 'converts back to the same types: {"$date"}, {"$binary"}, {"$numberLong"}, ...', id: 'typed' },
      { label: 'JSON Lines, typed', description: 'one value per line', id: 'jsonl' },
      ...['msgpack', 'cbor', 'bson'].filter((f) => f !== r.fmt).map((f) => ({ label: NAMES[f], description: `.${EXT[f]}${f === 'bson' ? ' (documents only)' : ''}`, id: f })),
    ];
    let id = extra.format;
    if (!id) {
      const pick = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, title: `Convert ${r.name} (${NAMES[r.fmt]}) to...`, placeHolder: 'Save as...' });
      if (!pick) return undefined;
      id = pick.id;
    }
    if (!items.some((i) => i.id === id)) return undefined;
    let out; let ext; let binFmt = null;
    const one = r.values.length === 1 ? r.values[0] : { t: 'arr', v: r.values };
    try {
      if (id === 'plain' || id === 'typed') { out = Buffer.from(`${V.toJson(one, { mode: id, indent: 2 }).text}\n`, 'utf8'); ext = id === 'typed' ? 'typed.json' : 'json'; }
      else if (id === 'jsonl') { out = Buffer.from(r.values.map((v) => V.toJson(v, { mode: 'typed', indent: 0 }).text).join('\n') + '\n', 'utf8'); ext = 'jsonl'; }
      else { out = W.encodeAll(id, r.values.map((v) => V.lower(v, id))); ext = EXT[id]; binFmt = id; }
    } catch (e) { vscode.window.showErrorMessage(`Cannot write ${NAMES[id] || 'the file'}: ${e.message}`); return undefined; }
    const dest = extra.dest || await vscode.window.showSaveDialog({ defaultUri: sibling(uri, `${stem(uri)}.${ext}`), filters: { [ext.toUpperCase()]: [ext.replace(/^typed\./, '')] }, title: `Save ${r.name} as ${items.find((i) => i.id === id).label}` });
    if (!dest) return undefined;
    if (sameFile(dest, uri)) { vscode.window.showErrorMessage('Choose another file name: the conversion never writes over the file it reads.'); return undefined; }
    await writeBytes(dest, out);
    if (binFmt && fmtOfName(base(dest)) !== binFmt) viewer.overrides.set(dest.toString(), binFmt);
    await openResult(dest, out.length, binFmt);
    vscode.window.setStatusBarMessage(`Saved ${base(dest)}: ${n(r.values.length, 'value', 'values')}, ${n(out.length, 'byte', 'bytes')}`, 8000);
    await pro.produced('convert');
    return { dest, format: id, values: r.values.length, size: out.length };
  }

  // ---------- 2. Edit a value and save ----------
  async function editValue(arg, extra = {}) {
    if (!(await pro.allowed('edit', arg))) return undefined;
    const uri = (arg && arg.scheme) ? arg : viewer.active && viewer.active.uri;
    const opts = extra && typeof extra === 'object' ? extra : {};
    if (!uri) { vscode.window.showInformationMessage('Open a MessagePack, CBOR or BSON file, click a value in the tree, then use Edit value.'); return undefined; }
    let d = viewer.docFor(uri);
    if (!d) {
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW);
      vscode.window.setStatusBarMessage('Click a value in the tree, then click Edit value (Pro) beside it.', 8000);
      return undefined;
    }
    const s = d.session;
    if (!s) { vscode.window.showInformationMessage(`${d.name} could not be read, so it cannot be edited.`); return undefined; }
    const id = opts.id !== undefined && opts.id !== null ? Number(opts.id) : d.selected;
    const node = id !== undefined ? s.nodes.get(id) : null;
    const det = node ? s.details(id) : null;
    if (!det || !det.editable) {
      vscode.window.showInformationMessage(det ? `${det.type} values cannot be edited here. Edit works on text, numbers, booleans, null, dates, ObjectIds, decimals and binary data.` : 'Click a value in the tree first, then use Edit value.');
      return undefined;
    }
    const before = editText(node.item);
    let input = opts.input;
    if (input === undefined) {
      input = await vscode.window.showInputBox({
        ignoreFocusOut: true, title: `Edit ${det.path} (${det.type}) in ${d.name}`, value: before,
        prompt: node.item.kind === 'str' ? 'The new text (no quotes needed).' : node.item.kind === 'bin' ? 'The bytes as hex.' : 'The new value. A JSON value such as "text", 12, true, null or {"$date": "..."} changes the type.',
        validateInput: (t) => { const r = parseEdit(node.item, t, s.fmt); return r.error || undefined; },
      });
    }
    if (input === undefined) return undefined;
    const pv = parseEdit(node.item, input, s.fmt);
    if (pv.error) { vscode.window.showErrorMessage(pv.error); return undefined; }
    let res;
    try { res = W.spliceValue(s.fmt, s.buf, s.chain(id), V.lower(pv.v, s.fmt)); } catch (e) { vscode.window.showErrorMessage(`The value was not saved: ${e.message}`); return undefined; }
    let where = opts.where;
    if (!where) {
      const pick = await vscode.window.showQuickPick([
        { label: `Save into ${d.name}`, description: 'writes the file now', id: 'file' },
        { label: 'Save as a copy...', description: 'the original stays as it is', id: 'copy' },
      ], { ignoreFocusOut: true, title: `${det.path}: ${V.short({ t: 'str', v: before }, 60)} -> ${V.short({ t: 'str', v: String(input) }, 60)}`, placeHolder: 'Where to save the change' });
      if (!pick) return undefined;
      where = pick.id;
    }
    let dest = uri;
    if (where === 'copy') {
      const ext = (/\.[^.]+$/.exec(d.name) || [''])[0];
      dest = opts.dest || await vscode.window.showSaveDialog({ defaultUri: sibling(uri, `${stem(uri)}.edited${ext}`), title: 'Save the edited file as' });
      if (!dest) return undefined;
    }
    if (sameFile(dest, uri)) d.skipWatch = Date.now() + 1500;
    await writeBytes(dest, res.bytes);
    if (sameFile(dest, uri)) await viewer.refresh(d, node.chainIdx);
    else { if (s.fmt !== fmtOfName(base(dest))) viewer.overrides.set(dest.toString(), s.fmt); await vscode.commands.executeCommand('vscode.openWith', dest, VIEW, { viewColumn: vscode.ViewColumn.Beside, preview: true }); }
    vscode.window.setStatusBarMessage(`Saved ${det.path} in ${base(dest)}: ${n(res.oldLen, 'byte', 'bytes')} became ${n(res.newLen, 'byte', 'bytes')}; the rest of the file is unchanged.`, 8000);
    await pro.produced('edit');
    return { dest, path: det.path, size: res.bytes.length, oldLen: res.oldLen, newLen: res.newLen };
  }

  // ---------- 3. Compare two files ----------
  async function pickOther(uriA, title) {
    const items = [];
    const seen = new Set([uriA.toString()]);
    for (const d of viewer.docs) if (!seen.has(d.uri.toString()) && d.session) { seen.add(d.uri.toString()); items.push({ label: d.name, description: 'open in the viewer', uri: d.uri }); }
    let files = [];
    try { files = await vscode.workspace.findFiles('**/*.{msgpack,mpk,cbor,bson,MSGPACK,MPK,CBOR,BSON}', '**/node_modules/**', 300); } catch (e) { files = []; }
    for (const u of files) if (!seen.has(u.toString())) { seen.add(u.toString()); items.push({ label: base(u), description: vscode.workspace.asRelativePath ? vscode.workspace.asRelativePath(u) : u.fsPath, uri: u }); }
    items.push({ label: 'Choose a file...', description: 'a .msgpack, .mpk, .cbor or .bson file', file: true });
    const pick = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, title, placeHolder: 'The file to compare with (B)', matchOnDescription: true });
    if (!pick) return undefined;
    if (!pick.file) return pick.uri;
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title, filters: FILTERS });
    return r && r[0];
  }

  function compareValues(a, b) {
    if (a.length === 1 && b.length === 1) return V.diff(a[0], b[0]);
    const all = { rows: [], counts: { added: 0, removed: 0, changed: 0, type: 0, same: 0 }, total: 0, truncated: false };
    const m = Math.max(a.length, b.length);
    for (let i = 0; i < m; i++) {
      const p = `#${i + 1}`;
      if (i >= a.length) { all.counts.added++; all.rows.push({ path: p, kind: 'added', a: '', b: V.short(b[i]) }); continue; }
      if (i >= b.length) { all.counts.removed++; all.rows.push({ path: p, kind: 'removed', a: V.short(a[i]), b: '' }); continue; }
      const r = V.diff(a[i], b[i], { root: p, max: 10000 - all.rows.length });
      for (const k of Object.keys(all.counts)) all.counts[k] += r.counts[k];
      all.rows.push(...r.rows);
    }
    all.total = all.counts.added + all.counts.removed + all.counts.changed + all.counts.type;
    all.truncated = all.total > all.rows.length;
    return all;
  }
  function markdown(r, nameA, nameB, fa, fb) {
    const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const lines = [`# Comparison: ${nameA} and ${nameB}`, '', `A: ${nameA} (${fa}). B: ${nameB} (${fb}).`, '',
      `- Added in B: ${r.counts.added}`, `- Removed (only in A): ${r.counts.removed}`, `- Changed values: ${r.counts.changed}`, `- Changed types: ${r.counts.type}`, `- Values the same: ${r.counts.same}`, '',
      '| Path | Change | A | B |', '| --- | --- | --- | --- |', ...r.rows.map((x) => `| \`${cell(x.path)}\` | ${x.kind === 'type' ? 'type changed' : x.kind} | ${cell(x.a)} | ${cell(x.b)} |`)];
    if (r.truncated) lines.push('', `The first ${r.rows.length} of ${r.total} differences are listed.`);
    return `${lines.join('\n')}\n`;
  }

  async function compare(arg, extra = {}) {
    if (!(await pro.allowed('compare', arg))) return undefined;
    const uriA = await targetFile(arg, 'Compare: choose the first file (A)');
    if (!uriA) return undefined;
    const uriB = extra.other || await pickOther(uriA, `Compare ${base(uriA)} with...`);
    if (!uriB) return undefined;
    let a; let b;
    try { a = await valuesOf(uriA); b = await valuesOf(uriB); } catch (e) { vscode.window.showErrorMessage(e.message); return undefined; }
    const r = compareValues(a.values, b.values);
    const nameA = base(uriA); const nameB = base(uriB);
    const title = `Compare: ${nameA} and ${nameB}`;
    const p = openPanel('compare', title);
    p.result = r;
    p.shown = async () => { await pro.produced('compare'); };
    const fa = `${NAMES[a.fmt]}, ${n(a.values.length, 'value', 'values')}`; const fb = `${NAMES[b.fmt]}, ${n(b.values.length, 'value', 'values')}`;
    p.actions = async (id) => {
      if (id !== 'md') return;
      const dest = await vscode.window.showSaveDialog({ defaultUri: sibling(uriA, `${stem(uriA)}-vs-${stem(uriB)}.md`), filters: { Markdown: ['md'] }, title: 'Save the comparison as Markdown' });
      if (!dest) return;
      await writeBytes(dest, markdown(r, nameA, nameB, fa, fb));
      p.post({ type: 'patch', target: 'saved', html: `Saved ${esc(dest.fsPath || dest.path)}.` });
    };
    const label = { added: 'added', removed: 'removed', changed: 'changed', type: 'type changed' };
    const rows = r.rows.slice(0, MAX_ROWS).map((x) => `<tr class="${x.kind}" data-kind="${x.kind}"><td><code>${esc(x.path)}</code></td><td>${label[x.kind]}</td><td><code>${esc(x.a)}</code></td><td><code>${esc(x.b)}</code></td></tr>`);
    const html = `<p class="row"><button class="tb act" data-id="md">Save report as Markdown...</button> <span id="saved" class="muted"></span></p>
<div class="stats"><div><b id="nAdded">${r.counts.added}</b><span>added in B</span></div><div><b id="nRemoved">${r.counts.removed}</b><span>only in A</span></div><div><b id="nChanged">${r.counts.changed}</b><span>${r.counts.changed === 1 ? 'value changed' : 'values changed'}</span></div><div><b id="nType">${r.counts.type}</b><span>${r.counts.type === 1 ? 'type changed' : 'types changed'}</span></div><div><b id="nSame">${r.counts.same}</b><span>the same</span></div></div>
<p class="muted">A: ${esc(nameA)} (${esc(fa)}). B: ${esc(nameB)} (${esc(fb)}). Maps are matched by key, arrays by position${a.values.length !== 1 || b.values.length !== 1 ? ', and the values of a stream by their number (#1, #2, ...)' : ''}. 1 and 1.0 count as a type change (integer and float).</p>
${rows.length ? `<table id="diffTable" class="sort"><thead><tr><th>Path</th><th>Change</th><th>A</th><th>B</th></tr></thead><tbody>${rows.join('')}</tbody></table>${r.rows.length > MAX_ROWS || r.truncated ? `<p class="muted">The first ${Math.min(MAX_ROWS, r.rows.length)} of ${r.total} differences are listed.</p>` : ''}` : '<p id="noDiff">The two files hold the same values.</p>'}`;
    await p.show({ title, html });
    return r;
  }

  // ---------- 4. Batch convert a folder to JSON ----------
  async function folderOf(arg) {
    let u = arg && arg.scheme ? arg : viewer.active ? viewer.active.uri : undefined;
    if (u) {
      try { const st = await vscode.workspace.fs.stat(u); if (st.type & 2) return u; } catch (e) { /* not there */ }
      return vscode.Uri.joinPath(u, '..');
    }
    const r = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Convert this folder', title: 'Batch convert: choose a folder' });
    u = r && r[0];
    return u;
  }
  async function listFiles(dir, deep, out, depth = 0) {
    let entries = [];
    try { entries = await vscode.workspace.fs.readDirectory(dir); } catch (e) { return out; }
    entries.sort((x, y) => x[0].localeCompare(y[0]));
    for (const [name, type] of entries) {
      if (out.length >= MAX_FILES) break;
      const u = vscode.Uri.joinPath(dir, name);
      if (type & 2) { if (deep && depth < 20 && name !== 'node_modules' && name !== '.git') await listFiles(u, deep, out, depth + 1); }
      else if (BIN_RE.test(name)) out.push(u);
    }
    return out;
  }

  async function batch(arg, extra = {}) {
    if (!(await pro.allowed('batch', arg))) return undefined;
    const dir = await folderOf(arg);
    if (!dir) return undefined;
    let deep = extra.recursive;
    if (deep === undefined) {
      const pick = await vscode.window.showQuickPick([{ label: 'This folder only', id: false }, { label: 'This folder and its subfolders', id: true }], { ignoreFocusOut: true, title: `Batch convert ${base(dir)} to JSON`, placeHolder: 'Which files' });
      if (!pick) return undefined;
      deep = pick.id;
    }
    const files = await listFiles(dir, deep, []);
    if (!files.length) { vscode.window.showInformationMessage(`No .msgpack, .mpk, .cbor or .bson files in ${base(dir)}${deep ? ' or its subfolders' : ''}.`); return undefined; }
    let mode = extra.mode;
    if (!mode) {
      const pick = await vscode.window.showQuickPick([
        { label: 'JSON, plain', description: 'readable: binary as base64, dates as ISO text', id: 'plain' },
        { label: 'JSON, typed', description: 'converts back to the same types', id: 'typed' },
      ], { ignoreFocusOut: true, title: `Convert ${n(files.length, 'file', 'files')} to JSON`, placeHolder: 'Each file gets <name>.json next to it, for example orders.msgpack.json' });
      if (!pick) return undefined;
      mode = pick.id;
    }
    const outs = files.map((u) => vscode.Uri.joinPath(u, '..', `${base(u)}.json`));
    let overwrite = extra.overwrite;
    if (overwrite === undefined) {
      let have = 0;
      for (const o of outs) if (await exists(o)) have++;
      if (have) {
        const pick = await vscode.window.showQuickPick([{ label: `Replace the ${n(have, 'JSON file', 'JSON files')} that exist`, id: true }, { label: 'Skip those files', id: false }], { ignoreFocusOut: true, title: `${n(have, 'output file exists', 'output files exist')} already` });
        if (!pick) return undefined;
        overwrite = pick.id;
      } else overwrite = true;
    }
    const rows = [];
    const rel = (u) => path.posix.relative(dir.path, u.path) || base(u);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Converting ${n(files.length, 'file', 'files')} to JSON`, cancellable: true }, async (progress, token) => {
      for (let i = 0; i < files.length; i++) {
        if (token && token.isCancellationRequested) { rows.push({ file: rel(files[i]), status: 'skipped', note: 'cancelled' }); continue; }
        progress.report({ message: rel(files[i]), increment: 100 / files.length });
        const u = files[i];
        const fmt = fmtOfName(base(u));
        const row = { file: rel(u), fmt: NAMES[fmt], out: rel(outs[i]) };
        try {
          if (!overwrite && await exists(outs[i])) { rows.push({ ...row, status: 'skipped', note: 'the JSON file exists' }); continue; }
          const bytes = Buffer.from(await vscode.workspace.fs.readFile(u));
          row.bytesIn = bytes.length;
          const values = W.decodeAll(fmt, bytes);
          const one = values.length === 1 ? values[0] : { t: 'arr', v: values };
          const out = Buffer.from(`${V.toJson(one, { mode, indent: 2 }).text}\n`, 'utf8');
          await writeBytes(outs[i], out);
          rows.push({ ...row, status: 'ok', values: values.length, bytesOut: out.length });
        } catch (e) { rows.push({ ...row, status: 'failed', note: errText(e) }); }
      }
    });
    const ok = rows.filter((r) => r.status === 'ok').length;
    const failed = rows.filter((r) => r.status === 'failed').length;
    const skipped = rows.filter((r) => r.status === 'skipped').length;
    const title = `Batch: ${base(dir)} to JSON`;
    const p = openPanel('batch', title);
    p.result = rows;
    p.shown = async () => { if (ok) await pro.produced('batch'); };
    const tr = rows.slice(0, MAX_ROWS).map((r) => `<tr class="${r.status}" data-status="${r.status}"><td><code>${esc(r.file)}</code></td><td>${esc(r.fmt || '')}</td><td>${r.status === 'ok' ? 'converted' : esc(r.status)}</td><td>${r.values === undefined ? '' : r.values}</td><td>${r.bytesIn === undefined ? '' : r.bytesIn}</td><td>${r.status === 'ok' ? `<code>${esc(r.out)}</code> (${r.bytesOut} bytes)` : esc(r.note || '')}</td></tr>`);
    const html = `<div class="stats"><div><b id="nOk">${ok}</b><span>converted</span></div><div><b id="nFailed">${failed}</b><span>could not be read</span></div><div><b id="nSkipped">${skipped}</b><span>skipped</span></div></div>
<p class="muted">Folder ${esc(dir.fsPath || dir.path)}${deep ? ' and its subfolders' : ''}. ${mode === 'typed' ? 'Typed JSON (converts back to the same types).' : 'Plain JSON.'} A file with more than one value becomes one JSON array.</p>
<table id="batchTable" class="sort"><thead><tr><th>File</th><th>Format</th><th>Result</th><th>Values</th><th>Bytes</th><th>JSON file or problem</th></tr></thead><tbody>${tr.join('')}</tbody></table>`;
    await p.show({ title, html });
    vscode.window.setStatusBarMessage(`Batch: ${n(ok, 'file', 'files')} converted to JSON${failed ? `, ${failed} could not be read` : ''}${skipped ? `, ${skipped} skipped` : ''}.`, 8000);
    return { rows, ok, failed, skipped, dir };
  }

  return { convert, editValue, compare, batch, panels, valuesOf };
}

module.exports = { createTools, sibling };
