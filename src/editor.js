'use strict';
// The custom editor msgpackViewer.view (default for *.msgpack, *.mpk, *.cbor and *.bson): a read-only tree of the
// file's values with types, sizes and byte offsets, a JSON view with copy, search and the details of a value.
// The file bytes are read through VS Code's file system API; nothing is written here (the Pro edit tool in tools.js
// writes a file only after the user chose to). The webview has no network access (CSP default-src 'none').
const vscode = require('vscode');
const path = require('path');
const { Session, fmtOfName, NAMES, PAGE } = require('./core/view');
const C = require('./core/common');
const { editorHtml } = require('./html');
const support = require('./support');

const VIEW = 'msgpackViewer.view';
const PREFIX = 'msgpackViewer';
const MAX_FILE = 512 * 1024 * 1024;
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const HEX_EDITORS = [['zovo.zovo-hex-viewer', 'hexViewer.editor', 'Hex Viewer'], ['ms-vscode.hexeditor', 'hexEditor.hexedit', 'Hex Editor']];

/** Reads a file as one of the three formats: { session } or { error, size }. */
async function loadFile(uri, fmt) {
  const name = path.posix.basename(uri.path);
  const f = fmt || fmtOfName(name) || 'msgpack';
  try {
    const st = await vscode.workspace.fs.stat(uri);
    if (st && st.size > MAX_FILE) return { fmt: f, error: `This file is ${C.sizeText(st.size)}, more than the 512 MB the viewer reads.`, size: st.size };
  } catch (e) { /* stat is optional */ }
  const bytes = await vscode.workspace.fs.readFile(uri);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buf.length) return { fmt: f, error: 'This file is empty (0 bytes).', size: 0, empty: true };
  return { fmt: f, session: new Session(buf, f, name), size: buf.length };
}

class Viewer {
  constructor(context, hooks = {}) {
    this.context = context;
    this.hooks = hooks;
    this.docs = new Set();
    this.active = null;
    this.overrides = new Map(); // uri -> format picked with Read as / Open as
    this._success = new WeakSet();
  }
  dispose() { for (const d of this.docs) for (const l of d.listeners) { try { l.dispose(); } catch (e) { /* gone */ } } this.docs.clear(); }

  hexEditor() {
    for (const [id, viewType, name] of HEX_EDITORS) { try { if (vscode.extensions.getExtension(id)) return { viewType, name }; } catch (e) { /* none */ } }
    return null;
  }

  /** The open view of uri (the active one first), or null. */
  docFor(uri) {
    const key = uri.toString();
    if (this.active && this.active.uri.toString() === key) return this.active;
    for (const d of this.docs) if (d.uri.toString() === key) return d;
    return null;
  }

  send(d, msg) { try { const r = d.panel.webview.postMessage(msg); if (r && r.then) r.then(undefined, () => false); } catch (e) { /* disposed */ } }

  setup(d, panel) {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const reach = this.hooks.reach ? this.hooks.reach() : null;
    panel.webview.options = { enableScripts: true, localResourceRoots: [media], enableCommandUris: (reach ? reach.commandIds() : []).concat(support.commandUris(PREFIX)) };
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'viewer.css')).toString(),
      title: d.name, head: reach ? (n) => reach.headHtml(n) : undefined, showSupportLinks: setting('showSupportLinks', true) !== false,
      showPro: setting('showProTools', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    this.docs.add(d);
    const setActive = () => { if (panel.active) { this.active = d; } };
    setActive();
    d.listeners.push(panel.onDidChangeViewState(setActive));
    panel.onDidDispose(() => { this.docs.delete(d); for (const l of d.listeners) { try { l.dispose(); } catch (e) { /* gone */ } } if (this.active === d) this.active = null; });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try { await this.onMessage(d, m); } catch (e) { this.send(d, { type: 'note', text: String((e && e.message) || e) }); }
    });
  }

  async reload(d) {
    const fmt = this.overrides.get(d.uri.toString()) || d.fmt;
    try { d.data = await loadFile(d.uri, fmt); } catch (e) { d.data = { fmt, error: String((e && e.message) || e) }; }
    d.fmt = d.data.fmt;
    d.session = d.data.session || null;
  }

  init(d, keep) {
    const s = d.session;
    const base = { type: 'init', name: d.name, fmt: d.fmt, fmtName: NAMES[d.fmt], formats: Object.entries(NAMES), size: d.data.size || 0, sizeText: C.sizeText(d.data.size || 0), showPro: setting('showProTools', true) !== false, keep: keep || null };
    const hex = this.hexEditor();
    if (!s) {
      this.send(d, { ...base, state: d.data.empty ? 'empty' : 'error', error: d.data.error, hex: hex ? hex.name : '' });
      if (!d.data.empty && this.hooks.onFailure) this.hooks.onFailure(d);
      return;
    }
    const top = s.children(0);
    const err = s.top.err;
    let banner = '';
    if (err) {
      const n = s.top.entries.filter((e) => !e.broken).length;
      banner = s.fmt === 'bson'
        ? `Bad data at ${C.at(err.off)}: ${err.message} ${s.top.lengthErr ? (s.count ? `The ${C.plural(s.count, 'document', 'documents')} before it ${s.count === 1 ? 'is' : 'are'} shown.` : 'Nothing before it could be read.') : 'The document that holds it is marked; open it to find the spot. The other documents read fine.'}`
        : `Bad data at ${C.at(err.off)}: ${err.message} ${n ? `The ${C.plural(n, 'value', 'values')} before it ${n === 1 ? 'is' : 'are'} shown${s.top.partial ? ', and the damaged one is marked' : ''}.` : (s.top.partial ? 'The damaged value is marked; open it to see what could be read.' : 'Nothing before it could be read.')}`;
      if (!s.top.entries.length && !s.top.partial && this.hooks.onFailure) this.hooks.onFailure(d);
    }
    this.send(d, {
      ...base, state: 'ready', count: s.count, multi: s.multi, rows: top.rows, more: top.more, banner, hint: s.hint, errOff: err ? err.off : -1,
      hex: hex ? hex.name : '', page: PAGE,
    });
  }

  async onMessage(d, m) {
    const s = d.session;
    switch (m.type) {
      case 'ready': this.init(d); return;
      case 'rendered':
        if (!this._success.has(d) && s && !s.top.err) { this._success.add(d); if (this.hooks.onSuccess) this.hooks.onSuccess(d); }
        return;
      case 'children': if (s) this.send(d, { type: 'children', ...s.children(m.id, Number(m.start) || 0, Number(m.upTo) || 0) }); return;
      case 'select': {
        if (!s) return;
        d.selected = Number(m.id);
        const det = s.details(m.id);
        if (det) this.send(d, { type: 'details', details: det });
        return;
      }
      case 'json': {
        if (!s) return;
        const id = m.id === undefined || m.id === null ? 0 : Number(m.id);
        const r = s.json(id);
        this.send(d, { type: 'json', id, ...r });
        return;
      }
      case 'search': {
        if (!s) return;
        const q = String(m.q || '').trim();
        const r = q ? s.search(q) : { hits: [], more: false };
        this.send(d, { type: 'results', q, hits: r.hits, more: r.more });
        return;
      }
      case 'reveal': {
        if (!s) return;
        const chain = Array.isArray(m.chain) ? m.chain.map(Number) : [];
        const levels = [];
        let parent = s.root;
        for (const i of chain) {
          const page = s.children(parent.id, 0, i);
          levels.push(page);
          const sc = parent.id === 0 ? parent.scan : s.scanOf(parent);
          parent = i < 0 ? s.child(parent, sc.entries.length, true) : s.child(parent, i);
        }
        this.send(d, { type: 'chain', levels, target: parent.id });
        return;
      }
      case 'copy': {
        if (!s) return;
        let text = '';
        let what = 'the value';
        const id = Number(m.id) || 0;
        if (m.what === 'path') { const n = s.nodes.get(id); text = n ? (n.path || '(root)') : ''; what = 'the path'; }
        else if (m.what === 'json') { const r = s.json(id, { max: 50 * 1024 * 1024 }); if (r.error) { this.send(d, { type: 'note', text: r.error }); return; } text = r.text; what = 'the JSON'; }
        else { const det = s.details(id); const n = s.nodes.get(id); if (n && (n.item.kind === 'str' || n.item.kind === 'code' || n.item.kind === 'symbol')) text = n.item.v; else if (det && ['map', 'array', 'tag', 'codews'].includes(det.kind)) { const r = s.json(id, { max: 50 * 1024 * 1024 }); text = r.text || ''; } else text = det ? det.value : ''; }
        await vscode.env.clipboard.writeText(text);
        this.send(d, { type: 'copied', what, chars: text.length });
        vscode.window.setStatusBarMessage(`Copied ${what} (${C.plural(text.length, 'character', 'characters')})`, 3000);
        return;
      }
      case 'readAs': {
        if (!NAMES[m.fmt]) return;
        this.overrides.set(d.uri.toString(), m.fmt);
        d.fmt = m.fmt;
        await this.reload(d);
        this.init(d);
        return;
      }
      case 'openText': await vscode.commands.executeCommand('vscode.openWith', d.uri, 'default'); return;
      case 'openHex': { const h = this.hexEditor(); if (h) await vscode.commands.executeCommand('vscode.openWith', d.uri, h.viewType); return; }
      case 'pro': {
        const cmd = { edit: 'msgpackViewer.editValue', convert: 'msgpackViewer.convert', compare: 'msgpackViewer.compare', batch: 'msgpackViewer.batch' }[m.tool];
        if (cmd) await vscode.commands.executeCommand(cmd, d.uri, { id: m.id });
        return;
      }
      default:
    }
  }

  /** After a Pro edit wrote the file: read it again and show the same value. */
  async refresh(d, chainIdx) {
    await this.reload(d);
    this.init(d, chainIdx ? { chain: chainIdx } : null);
  }
}

/** msgpackViewer.view: a read-only custom editor; the document is the file's URI. */
class Provider {
  constructor(viewer) { this.viewer = viewer; }
  async openCustomDocument(uri) { return { uri, dispose() {} }; }
  async resolveCustomEditor(handle, panel) {
    const v = this.viewer;
    const uri = handle.uri;
    const name = path.posix.basename(uri.path);
    const d = { uri, name, fmt: v.overrides.get(uri.toString()) || fmtOfName(name) || 'msgpack', panel, listeners: [], data: null, session: null };
    await v.reload(d);
    try {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), name));
      let timer = null;
      const again = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => { if (d.skipWatch && Date.now() < d.skipWatch) return; await v.reload(d); v.init(d); }, 500);
      };
      d.listeners.push(w, w.onDidChange(again), w.onDidCreate(again));
    } catch (e) { /* no watcher: the view still works */ }
    v.setup(d, panel);
  }
}

module.exports = { Viewer, Provider, loadFile, VIEW, PREFIX, MAX_FILE };
