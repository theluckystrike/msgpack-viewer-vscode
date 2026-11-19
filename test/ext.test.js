'use strict';
// Extension tests with the vscode stub: the listing, activation (nothing shows), the custom editor (tree, children,
// details, JSON, search, copy, Read as, bad files), webview safety, and the four Pro tools with 1 free try each:
// the 1st use on file A runs fully, the use on file B opens the Pro panel (also after a reload of the window).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadExtension, tmpDir, cleanup } = require('./support/vscode-stub');
const { editorHtml, panelHtml } = require('../src/html');
const W = require('../src/core/walk');
const V = require('../src/core/value');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
test.after(() => cleanup());

function fakePanel() {
  let onMsg;
  const posted = [];
  return {
    posted, viewColumn: 1, active: true,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
    send: (m) => onMsg(m),
    last: (type) => [...posted].reverse().find((m) => m.type === type),
  };
}

const activated = [];
function activate(folder, state) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  if (state) for (const [k, v] of state) s.state.set(k, v);
  s.api = s.ext.activate(s.context);
  activated.push(s);
  s.log.onPost = (panel, m) => { if (m.type === 'show' && m.html) panel.send({ type: 'shown' }); };
  s.opened = [];
  s.commands.set('vscode.openWith', async (uri, viewType) => {
    s.opened.push([uri.fsPath, viewType]);
    if (viewType !== 'msgpackViewer.view') return undefined;
    s.lastEditor = await openEditor(s, uri.fsPath);
    return undefined;
  });
  return s;
}
test.after(() => { for (const s of activated) s.api.viewer.dispose(); });

/** Opens a file in the viewer like VS Code does. */
async function openEditor(s, file) {
  const uri = s.vscode.Uri.file(file);
  const panel = fakePanel();
  const h = await s.api.provider.openCustomDocument(uri);
  await s.api.provider.resolveCustomEditor(h, panel);
  await panel.send({ type: 'ready' });
  const init = panel.last('init');
  if (init && init.state === 'ready') await panel.send({ type: 'rendered' });
  const d = [...s.api.viewer.docs].find((x) => x.panel === panel);
  s.api.viewer.active = d;
  return { panel, init, d };
}
async function ask(panel, msg, type) { const n = panel.posted.length; await panel.send(msg); return panel.posted.slice(n).find((m) => m.type === type); }

function ws() {
  const dir = tmpDir('mp-ws-');
  for (const f of fs.readdirSync(SAMPLES)) fs.copyFileSync(path.join(SAMPLES, f), path.join(dir, f));
  // B files: the orders after a change, a second BSON dump, a JSON file, broken and empty files
  const orders = W.decodeAll('msgpack', fs.readFileSync(path.join(SAMPLES, 'orders.msgpack')));
  orders[1].v.find(([k]) => k.v === 'status')[1] = { t: 'str', v: 'paid' };
  orders[2].v.push([{ t: 'str', v: 'coupon' }, { t: 'str', v: 'WINTER' }]);
  fs.writeFileSync(path.join(dir, 'orders-after.msgpack'), W.encodeAll('msgpack', orders));
  fs.writeFileSync(path.join(dir, 'small.cbor'), W.encodeOne('cbor', { t: 'map', v: [[{ t: 'str', v: 'k' }, { t: 'int', v: 1n }]] }));
  fs.writeFileSync(path.join(dir, 'points.json'), '[{"x": 1, "y": 2.5, "at": {"$date": "2026-11-19T00:00:00Z"}}, {"x": 2, "y": 3.0}]\n');
  fs.writeFileSync(path.join(dir, 'broken.msgpack'), Buffer.from([0x82, 0xa1, 0x61, 0x01, 0xa1, 0x62, 0xc1]));
  fs.writeFileSync(path.join(dir, 'empty.cbor'), Buffer.alloc(0));
  fs.writeFileSync(path.join(dir, 'pointer.bson'), 'version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 10\n');
  fs.mkdirSync(path.join(dir, 'batchA', 'sub'), { recursive: true });
  fs.copyFileSync(path.join(SAMPLES, 'orders.msgpack'), path.join(dir, 'batchA', 'orders.msgpack'));
  fs.copyFileSync(path.join(SAMPLES, 'users.bson'), path.join(dir, 'batchA', 'sub', 'users.bson'));
  fs.writeFileSync(path.join(dir, 'batchA', 'bad.cbor'), Buffer.from([0x9f, 0x01]));
  fs.mkdirSync(path.join(dir, 'batchB'));
  fs.copyFileSync(path.join(SAMPLES, 'sensor.cbor'), path.join(dir, 'batchB', 'sensor.cbor'));
  return dir;
}
const proPanels = (s, title) => s.log.info.filter((m) => m.text === `${title} is part of Zovo Pro.`);

// ---------- package.json and listing ----------
test('listing: display name, phrase first, description, 5 keywords, engines, activation, repository', () => {
  assert.equal(pkg.displayName, 'MsgPack Viewer & BSON, CBOR');
  assert.ok(pkg.displayName.length <= 30);
  assert.match(pkg.description, /^MsgPack viewer/);
  assert.deepEqual(pkg.keywords, ['msgpack', 'messagepack', 'bson', 'cbor', 'binary json']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.deepEqual([pkg.publisher, pkg.name, pkg.license, pkg.version], ['zovo', 'zovo-msgpack-viewer', 'MIT', '0.1.0']);
  assert.equal(pkg.repository.url, 'https://github.com/theluckystrike/msgpack-viewer-vscode');
  assert.deepEqual(pkg.activationEvents, ['onUri']);
  assert.ok(fs.existsSync(path.join(ROOT, 'icon.png')));
  assert.equal(pkg.contributes.configuration.properties['zovo.msgpack.trial.enabled'].default, true);
  assert.equal(pkg.contributes.configuration.properties['zovo.msgpack.trial.enabled'].description, 'Show the 7-day Zovo Pro trial button in the Pro panel.');
});
test('editor: *.msgpack, *.mpk, *.cbor and *.bson by default and nothing else (never *.bin or *.dat)', () => {
  const [ed] = pkg.contributes.customEditors;
  assert.deepEqual([ed.viewType, ed.priority, ed.selector.map((x) => x.filenamePattern)], ['msgpackViewer.view', 'default', ['*.msgpack', '*.mpk', '*.cbor', '*.bson']]);
  assert.equal(pkg.contributes.customEditors.length, 1);
  assert.doesNotMatch(JSON.stringify(pkg.contributes.customEditors), /bin|dat|json/i);
});
test('menus: Explorer entries match upper-case names; wrappers titled "Zovo Pro: ", hidden from the palette; no title on menu items', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  assert.ok(!raw.includes('\\\\\\\\.'));
  const items = Object.values(pkg.contributes.menus).flat();
  assert.ok(items.every((m) => !('title' in m)));
  for (const m of pkg.contributes.menus['explorer/context']) {
    const re = new RegExp(/resourceFilename =~ \/(.*)\/i/.exec(m.when)[1], 'i');
    for (const f of ['a.msgpack', 'B.MPK', 'SAMPLE.CBOR', 'dump.Bson']) assert.ok(re.test(f), f);
    for (const f of ['a.bin', 'a.dat', 'a.json', 'msgpack.txt']) assert.ok(!re.test(f), f);
  }
  const wrappers = pkg.contributes.commands.filter((c) => /\.zovoPro\./.test(c.command));
  assert.equal(wrappers.length, 4);
  assert.ok(wrappers.every((c) => c.title.startsWith('Zovo Pro: ')));
  for (const w of wrappers) assert.ok(pkg.contributes.menus.commandPalette.some((m) => m.command === w.command && m.when === 'false'));
});
test('every contributed command is registered, and every registered msgpackViewer command is contributed', () => {
  const s = activate();
  const contributed = pkg.contributes.commands.map((c) => c.command);
  for (const c of contributed) assert.ok(s.commands.has(c), c);
  for (const c of s.commands.keys()) if (c.startsWith('msgpackViewer.')) assert.ok(contributed.includes(c), c);
});
test('activation shows nothing: no message, no panel, no command run', () => {
  const s = activate();
  assert.equal(s.log.info.length + s.log.warn.length + s.log.error.length, 0);
  assert.equal(s.log.panel, undefined);
  assert.equal(s.log.commands.length, 0);
});

// ---------- the viewer ----------
test('viewer: the orders sample opens as 3 values; the first opens; children, details, JSON, search, copy', async () => {
  const dir = ws();
  const s = activate(dir);
  const { panel, init } = await openEditor(s, path.join(dir, 'orders.msgpack'));
  assert.deepEqual([init.state, init.fmt, init.count, init.multi, init.banner], ['ready', 'msgpack', 3, true, '']);
  assert.deepEqual(init.rows.map((r) => [r.key, r.type, r.off, r.preview]), [['#1', 'fixmap', 0, '{12 keys}'], ['#2', 'fixmap', 235, '{12 keys}'], ['#3', 'fixmap', 410, '{10 keys}']]);
  const kids = await ask(panel, { type: 'children', id: init.rows[0].id }, 'children');
  const created = kids.rows.find((r) => r.key === 'created');
  assert.deepEqual([created.type, created.off, created.size, created.preview], ['timestamp 64', 43, 10, '2026-11-02T09:14:05.250Z']);
  const det = await ask(panel, { type: 'select', id: created.id }, 'details');
  assert.equal(det.details.path, '#1.created');
  assert.equal(det.details.editable, true);
  const json = await ask(panel, { type: 'json', id: init.rows[0].id }, 'json');
  assert.match(json.text, /"customer": "C-2201"/);
  assert.match(json.text, /"thumb": "iVBORw0KGgoAAAANSUhEUg=="/);
  const all = await ask(panel, { type: 'json', id: 0 }, 'json');
  assert.equal(JSON.parse(all.text).length, 3);
  const found = await ask(panel, { type: 'search', q: 'front desk' }, 'results');
  assert.deepEqual(found.hits.map((h) => h.path), ['#2.note']);
  const chain = await ask(panel, { type: 'reveal', chain: found.hits[0].chain }, 'chain');
  assert.equal(chain.levels.length, 2);
  await panel.send({ type: 'copy', what: 'path', id: created.id });
  assert.equal(s.log.clipboard, '#1.created');
  await panel.send({ type: 'copy', what: 'value', id: kids.rows.find((r) => r.key === 'customer').id });
  assert.equal(s.log.clipboard, 'C-2201');
  await panel.send({ type: 'copy', what: 'json', id: kids.rows.find((r) => r.key === 'items').id });
  assert.equal(JSON.parse(s.log.clipboard)[1].sku, 'TEA-GRN');
  assert.equal(s.log.info.length + s.log.error.length, 0);
});
test('viewer: bad data shows its byte offset and the values before it; empty files and Git LFS pointers get a note', async () => {
  const dir = ws();
  const s = activate(dir);
  let o = await openEditor(s, path.join(dir, 'broken.msgpack'));
  assert.equal(o.init.state, 'ready');
  assert.match(o.init.banner, /^Bad data at byte 6 \(0x6\): Byte 0xC1 at byte 6 \(0x6\) is never used in MessagePack/);
  assert.equal(o.init.rows[0].broken, true);
  const k = await ask(o.panel, { type: 'children', id: o.init.rows[0].id }, 'children');
  assert.deepEqual([k.rows.map((r) => r.key), k.err.off], [['a'], 6]);
  o = await openEditor(s, path.join(dir, 'empty.cbor'));
  assert.deepEqual([o.init.state, o.init.error], ['empty', 'This file is empty (0 bytes).']);
  o = await openEditor(s, path.join(dir, 'pointer.bson'));
  assert.match(o.init.hint, /Git LFS pointer/);
  assert.match(o.init.banner, /^Bad data at byte 0/);
  assert.equal(s.log.error.length, 0);
});
test('viewer: a BSON length past the end says how many documents read, and "Nothing before it" for none', async () => {
  const dir = ws();
  const s = activate(dir);
  const doc = Buffer.from('0c0000001061000100000000', 'hex'); // { a: 1 }, 12 bytes
  const over = Buffer.from('130000001061000100000000000000000000', 'hex'); // says 19 bytes, 18 there
  fs.writeFileSync(path.join(dir, 'over0.bson'), over);
  fs.writeFileSync(path.join(dir, 'over1.bson'), Buffer.concat([doc, over]));
  let o = await openEditor(s, path.join(dir, 'over0.bson'));
  assert.match(o.init.banner, /^Bad data at byte 0 \(0x0\): .* Nothing before it could be read\.$/);
  assert.ok(!/\b0 documents\b/.test(o.init.banner), o.init.banner);
  o = await openEditor(s, path.join(dir, 'over1.bson'));
  assert.match(o.init.banner, /^Bad data at byte 12 \(0xC\): .* The 1 document before it is shown\.$/);
  assert.equal(s.log.error.length, 0);
});
test('viewer: Read as switches the format; the webview HTML has a strict CSP and no remote origin', async () => {
  const dir = ws();
  const s = activate(dir);
  const o = await openEditor(s, path.join(dir, 'users.bson'));
  const again = await ask(o.panel, { type: 'readAs', fmt: 'msgpack' }, 'init');
  assert.equal(again.fmt, 'msgpack');
  const back = await ask(o.panel, { type: 'readAs', fmt: 'bson' }, 'init');
  assert.deepEqual([back.fmt, back.count, back.banner], ['bson', 3, '']);
  for (const html of [editorHtml({ cspSource: 'vscode-resource:', scriptUri: 'a.js', styleUri: 'a.css', title: 'x' }), panelHtml({ cspSource: 'vscode-resource:', scriptUri: 'a.js', styleUri: 'a.css', title: 'x' })]) {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
    assert.match(csp, /^default-src 'none'/);
    assert.doesNotMatch(csp, /https?:|connect-src|worker-src|blob:|unsafe/);
    for (const m of html.matchAll(/<script([^>]*)>/g)) assert.match(m[1], /nonce=/);
  }
  const js = fs.readFileSync(path.join(ROOT, 'media', 'viewer.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'media', 'panel.js'), 'utf8');
  assert.doesNotMatch(js, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\//);
  const src = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js') && f !== 'support.js' && f !== 'rate.js').map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')).join('\n');
  assert.doesNotMatch(src, /require\('(https?|net|tls|dgram)'\)|fetch\(/);
});

// ---------- Pro tools: 1 free try each; A then B ----------
test('Pro convert: 1st use on file A writes typed JSON that reads back; the use on file B opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  const A = s.vscode.Uri.file(path.join(dir, 'orders.msgpack'));
  const dest = s.vscode.Uri.file(path.join(dir, 'orders.typed.json'));
  const r = await s.commands.get('msgpackViewer.convert')(A, { format: 'typed', dest });
  assert.equal(r.values, 3);
  const back = V.fromJsonText(fs.readFileSync(dest.fsPath, 'utf8'))[0].v;
  assert.ok(W.encodeAll('msgpack', back).equals(fs.readFileSync(A.fsPath)));
  assert.equal(s.state.get('msgpackViewer.proTrial').convert, 1);
  const B = s.vscode.Uri.file(path.join(dir, 'users.bson'));
  const r2 = await s.commands.get('msgpackViewer.convert')(B, { format: 'plain', dest: s.vscode.Uri.file(path.join(dir, 'users.json')) });
  assert.equal(r2, undefined);
  assert.equal(proPanels(s, 'Convert to JSON and from JSON').length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'users.json')));
});
test('Pro convert: JSON to BSON (one document per array item) and to MessagePack; Escape uses no try', async () => {
  const dir = ws();
  const s = activate(dir);
  const J = s.vscode.Uri.file(path.join(dir, 'points.json'));
  s.ui.quick.push(undefined);
  assert.equal(await s.commands.get('msgpackViewer.convert')(J), undefined);
  assert.equal((s.state.get('msgpackViewer.proTrial') || {}).convert, undefined);
  const r = await s.commands.get('msgpackViewer.convert')(J, { format: 'bson', dest: s.vscode.Uri.file(path.join(dir, 'points.bson')) });
  assert.equal(r.values, 2);
  const docs = W.decodeAll('bson', fs.readFileSync(path.join(dir, 'points.bson')));
  assert.deepEqual(docs.map((d) => d.v.map(([k, v]) => `${k.v}:${v.t}`).join()), ['x:int,y:float,at:date', 'x:int,y:float']);
  assert.deepEqual(s.opened.at(-1), [path.join(dir, 'points.bson'), 'msgpackViewer.view']);
});
test('Pro edit: 1st use on file A writes the new value into the same file; the use on file B opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  const A = path.join(dir, 'orders.msgpack');
  const before = fs.readFileSync(A);
  const o = await openEditor(s, A);
  const kids = await ask(o.panel, { type: 'children', id: o.init.rows[1].id }, 'children');
  const cust = kids.rows.find((r) => r.key === 'customer');
  const r = await s.commands.get('msgpackViewer.editValue')(s.vscode.Uri.file(A), { id: cust.id, input: 'C-9999-NEW', where: 'file' });
  assert.equal(r.path, '#2.customer');
  const after = fs.readFileSync(A);
  assert.equal(after.length, before.length + 4);
  assert.ok(after.subarray(0, cust.off).equals(before.subarray(0, cust.off)));
  assert.equal(W.decodeAll('msgpack', after)[1].v.find(([k]) => k.v === 'customer')[1].v, 'C-9999-NEW');
  assert.equal(s.state.get('msgpackViewer.proTrial').edit, 1);
  const re = o.panel.last('init');
  assert.deepEqual(re.keep, { chain: [1, 1] });
  const B = path.join(dir, 'users.bson');
  const ob = await openEditor(s, B);
  const bk = await ask(ob.panel, { type: 'children', id: ob.init.rows[0].id }, 'children');
  const bBefore = fs.readFileSync(B);
  const r2 = await s.commands.get('msgpackViewer.editValue')(s.vscode.Uri.file(B), { id: bk.rows[1].id, input: 'Ana', where: 'file' });
  assert.equal(r2, undefined);
  assert.equal(proPanels(s, 'Edit a value and save').length, 1);
  assert.ok(fs.readFileSync(B).equals(bBefore));
});
test('Pro edit: a copy keeps the original; a map or a bad input uses no try', async () => {
  const dir = ws();
  const s = activate(dir);
  const B = path.join(dir, 'users.bson');
  const o = await openEditor(s, B);
  const kids = await ask(o.panel, { type: 'children', id: o.init.rows[0].id }, 'children');
  assert.equal(await s.commands.get('msgpackViewer.editValue')(s.vscode.Uri.file(B), { id: kids.rows.find((r) => r.key === 'address').id }), undefined);
  assert.equal(await s.commands.get('msgpackViewer.editValue')(s.vscode.Uri.file(B), { id: kids.rows.find((r) => r.key === 'age').id, input: 'old', where: 'file' }), undefined);
  assert.equal((s.state.get('msgpackViewer.proTrial') || {}).edit, undefined);
  const copy = s.vscode.Uri.file(path.join(dir, 'users.edited.bson'));
  const before = fs.readFileSync(B);
  const r = await s.commands.get('msgpackViewer.editValue')(s.vscode.Uri.file(B), { id: kids.rows.find((r2) => r2.key === 'joined').id, input: '2026-01-01T00:00:00Z', where: 'copy', dest: copy });
  assert.equal(r.dest, copy);
  assert.ok(fs.readFileSync(B).equals(before));
  assert.equal(V.toJson(W.decodeAll('bson', fs.readFileSync(copy.fsPath))[0].v[7][1], { indent: 0 }).text, '"2026-01-01T00:00:00Z"');
});
test('Pro compare: 1st use on file A shows the differences; the use on file B opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  const A = s.vscode.Uri.file(path.join(dir, 'orders.msgpack'));
  const r = await s.commands.get('msgpackViewer.compare')(A, { other: s.vscode.Uri.file(path.join(dir, 'orders-after.msgpack')) });
  assert.deepEqual(r.rows.map((x) => [x.path, x.kind, x.a, x.b]), [['#2.status', 'changed', '"open"', '"paid"'], ['#3.coupon', 'added', '', '"WINTER"']]);
  await tick(20);
  assert.equal(s.state.get('msgpackViewer.proTrial').compare, 1);
  assert.match(s.log.panel.posted.find((m) => m.type === 'show').html, /id="nChanged">1</);
  const B = s.vscode.Uri.file(path.join(dir, 'users.bson'));
  assert.equal(await s.commands.get('msgpackViewer.compare')(B, { other: A }), undefined);
  assert.equal(proPanels(s, 'Compare two files').length, 1);
});
test('Pro batch: 1st use on folder A writes JSON next to each file; the use on folder B opens the Pro panel', async () => {
  const dir = ws();
  const s = activate(dir);
  const A = s.vscode.Uri.file(path.join(dir, 'batchA'));
  const r = await s.commands.get('msgpackViewer.batch')(A, { recursive: true, mode: 'plain' });
  assert.deepEqual([r.ok, r.failed, r.skipped], [2, 1, 0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'batchA', 'orders.msgpack.json'), 'utf8')).length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'batchA', 'sub', 'users.bson.json'), 'utf8'))[0].name, 'Ana Lima');
  assert.match(r.rows.find((x) => x.status === 'failed').note, /bad data at byte 2/);
  await tick(20);
  assert.equal(s.state.get('msgpackViewer.proTrial').batch, 1);
  const B = s.vscode.Uri.file(path.join(dir, 'batchB', 'sensor.cbor'));
  assert.equal(await s.commands.get('msgpackViewer.batch')(B, { recursive: false, mode: 'plain' }), undefined);
  assert.equal(proPanels(s, 'Batch convert a folder to JSON').length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'batchB', 'sensor.cbor.json')));
});
test('tries survive a reload: a new activation with the same state opens the panel for every used tool', async () => {
  const dir = ws();
  const state = new Map([['msgpackViewer.proTrial', { convert: 1, edit: 1, compare: 1, batch: 1 }]]);
  const s = activate(dir, state);
  assert.deepEqual(s.api.pro.tries(), { convert: 0, edit: 0, compare: 0, batch: 0 });
  await s.commands.get('msgpackViewer.convert')(s.vscode.Uri.file(path.join(dir, 'small.cbor')), { format: 'plain' });
  await s.commands.get('msgpackViewer.compare')(s.vscode.Uri.file(path.join(dir, 'small.cbor')), { other: s.vscode.Uri.file(path.join(dir, 'sensor.cbor')) });
  await s.commands.get('msgpackViewer.batch')(s.vscode.Uri.file(dir), { recursive: false, mode: 'plain' });
  await s.commands.get('msgpackViewer.editValue')(s.vscode.Uri.file(path.join(dir, 'small.cbor')), {});
  for (const t of ['Convert to JSON and from JSON', 'Compare two files', 'Batch convert a folder to JSON', 'Edit a value and save']) assert.equal(proPanels(s, t).length, 1, t);
  const row = s.api.reach.rowHtml();
  assert.equal((row.match(/0 tries left/g) || []).length, 4);
});
test('reach row: 4 tools with "1 free try" in a fresh window; README first screen and support links', () => {
  const s = activate();
  const row = s.api.reach.rowHtml();
  assert.equal((row.match(/<small>1 free try<\/small>/g) || []).length, 4); // the aria-label repeats it
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /!\[[^\]]+\]\(images\/screenshot\.png\)/);
  assert.match(readme, /Zovo Pro: USD 19 once/);
  for (const t of ['Convert to JSON and from JSON', 'Edit a value and save', 'Compare two files', 'Batch convert a folder to JSON']) assert.ok(readme.includes(t), t);
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'screenshot.png')));
});
