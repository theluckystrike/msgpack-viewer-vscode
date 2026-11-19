'use strict';
// MsgPack Viewer & BSON, CBOR by Zovo: opens MessagePack (.msgpack, .mpk), CBOR (.cbor) and BSON (.bson) files as a tree
// with types, sizes and byte offsets, a JSON view with copy, and search. Bad data shows its byte offset. No network,
// no telemetry, no other program is run. Activation shows nothing: no message, no popup. The viewer opens only for
// files the user opens, and it never reopens a tab in another editor by itself.
const vscode = require('vscode');
const path = require('path');
const { Viewer, Provider, VIEW } = require('./editor');
const { NAMES, fmtOfName } = require('./core/view');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'msgpackViewer';
const EXT_ID = 'zovo.zovo-msgpack-viewer';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

/** The file of the active editor tab (text, custom or other), if any. */
function activeTabUri() {
  try {
    const tab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab && tab.input;
    if (input && input.uri && input.uri.scheme) return input.uri;
  } catch (e) { /* older API */ }
  const ed = vscode.window.activeTextEditor;
  return ed ? ed.document.uri : undefined;
}

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'MsgPack Viewer' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, maximum: pro.TRIES, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  const viewer = new Viewer(context, {
    reach: () => reach,
    onSuccess: (d) => rating.success(d.uri),
    onFailure: () => rating.failure(),
  });
  sub(viewer);
  const provider = new Provider(viewer);
  sub(vscode.window.registerCustomEditorProvider(VIEW, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  const tools = createTools({ context, viewer, pro, reach });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, async (...a) => {
    try { return await fn(...a); } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); return undefined; }
  }));
  const target = (uri) => (uri && uri.scheme ? uri : undefined);
  const extraOf = (extra) => (extra && !extra.scheme && !Array.isArray(extra) ? extra : {});

  // Any file (also .bin, .dat or a file with no extension) as one of the three formats, picked here.
  reg(`${PREFIX}.openAs`, async (uri, extra) => {
    let u = target(uri) || activeTabUri();
    if (!u || u.scheme === 'untitled') {
      const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open', title: 'Open a file as MessagePack, CBOR or BSON' });
      u = r && r[0];
      if (!u) return undefined;
    }
    let fmt = extraOf(extra).format;
    if (!fmt) {
      const guess = fmtOfName(path.posix.basename(u.path));
      const pick = await vscode.window.showQuickPick(Object.entries(NAMES).map(([id, name]) => ({ label: name, description: id === guess ? 'by its file name' : '', id })), { ignoreFocusOut: true, title: `Open ${path.posix.basename(u.path)} as...` });
      if (!pick) return undefined;
      fmt = pick.id;
    }
    if (!NAMES[fmt]) return undefined;
    viewer.overrides.set(u.toString(), fmt);
    const open = viewer.docFor(u);
    if (open) { open.fmt = fmt; await viewer.refresh(open); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, VIEW);
  });
  reg(`${PREFIX}.openSample`, async (which) => {
    const files = { msgpack: 'orders.msgpack', cbor: 'sensor.cbor', bson: 'users.bson' };
    let id = typeof which === 'string' ? which : '';
    if (!files[id]) {
      const pick = await vscode.window.showQuickPick([
        { label: 'orders.msgpack', description: 'MessagePack: 3 order records one after another', id: 'msgpack' },
        { label: 'sensor.cbor', description: 'CBOR: a reading with tags, a float16 and an indefinite array', id: 'cbor' },
        { label: 'users.bson', description: 'BSON: 3 documents with ObjectId, dates and decimal128', id: 'bson' },
      ], { ignoreFocusOut: true, title: 'Open a sample file' });
      if (!pick) return undefined;
      id = pick.id;
    }
    // The sample opens as a copy in the extension's storage folder, so an edit never changes the installed files.
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'samples');
    const copy = vscode.Uri.joinPath(dir, files[id]);
    let there = false;
    try { await vscode.workspace.fs.stat(copy); there = true; } catch (e) { there = false; }
    if (!there) { await vscode.workspace.fs.createDirectory(dir); await vscode.workspace.fs.writeFile(copy, await vscode.workspace.fs.readFile(vscode.Uri.joinPath(context.extensionUri, 'samples', files[id]))); }
    return vscode.commands.executeCommand('vscode.openWith', copy, VIEW);
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.convert`, reach.wrap((uri, extra) => tools.convert(target(uri), extraOf(extra))));
  reg(`${PREFIX}.editValue`, reach.wrap((uri, extra) => tools.editValue(target(uri), extraOf(extra))));
  reg(`${PREFIX}.compare`, reach.wrap((uri, extra) => tools.compare(target(uri), extraOf(extra))));
  reg(`${PREFIX}.batch`, reach.wrap((uri, extra) => tools.batch(target(uri), extraOf(extra))));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { viewer, provider, tools, pro, reach };
}

function deactivate() {}

module.exports = { activate, deactivate };
