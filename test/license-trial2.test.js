// TRIAL2 (19 Nov 2026): the TRIAL1 7-day trial in the shared module. The trial button is first in the Pro panel (the
// panel still opens only after a click on a Pro tool whose free try is used). It starts only on its click. Day 7 ends
// it: one end panel, then the SPON1 panel. Tags _trialstart_<listing> and _trialend_<listing>. Kill switch
// zovo.<listing>.trial.enabled. No network, no notification.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
// factory/sprint/license/test or a listing's test/ folder (module in src/license or src/zovo)
const dir = '../src/license'; // this listing keeps the module in src/license
const IDX = require(`${dir}/index.js`);
const SRC = fs.readFileSync(path.join(__dirname, dir, 'index.js'), 'utf8');

const CARD = 'https://license.zovo.one/buy/zovo-pro';
const T = IDX.TRIAL_LABEL;
const SP = 'Pay with GitHub Sponsors (USD 19 once)';
const CB = 'Pay USD 19 by card';
const SD = 'See details';
function fakeVscode({ answers = [], setting, tabs } = {}) {
  const log = { modal: [], info: [], opened: [], items: [] };
  const global = new Map();
  const q = [...answers];
  const tabState = { active: tabs || null, listeners: [] };
  const vscode = {
    Uri: { parse: (s) => ({ toString: () => s, s }) },
    StatusBarAlignment: { Left: 1, Right: 2 },
    env: { openExternal: async (u) => { log.opened.push(u.toString()); return true; }, language: 'en', uriScheme: 'vscode', appName: 'Visual Studio Code' },
    window: {
      showInformationMessage: async (msg, ...rest) => {
        if (rest[0] && rest[0].modal) { log.modal.push({ msg, detail: rest[0].detail, buttons: rest.slice(1) }); return q.shift(); }
        log.info.push({ msg, buttons: rest }); return undefined;
      },
      showWarningMessage: async (m) => { log.info.push({ msg: m }); }, showErrorMessage: async (m) => { log.info.push({ msg: m }); },
      showQuickPick: async () => undefined, showInputBox: async () => undefined,
      onDidChangeWindowState: () => ({ dispose() {} }),
      createWebviewPanel: undefined,
      createStatusBarItem: (id, align, prio) => { const it = { id, align, prio, text: '', shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }; log.items.push(it); return it; },
      tabGroups: {
        get activeTabGroup() { return { activeTab: tabState.active }; },
        all: [],
        onDidChangeTabs: (fn) => { tabState.listeners.push(fn); return { dispose() {} }; },
        onDidChangeTabGroups: () => ({ dispose() {} }),
      },
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
    extensions: { all: [] },
    workspace: { getConfiguration: (section) => ({ get: (k, d) => (section === 'zovo.hex.trial' && k === 'enabled' && setting !== undefined ? setting : d) }) },
    authentication: { getSession: async () => undefined },
  };
  const context = { subscriptions: [], extension: { id: 'zovo.zovo-hex-viewer', packageJSON: { version: '9.9.9', contributes: { customEditors: [{ viewType: 'hexViewer.editor' }] } } },
    globalState: { get: (k) => global.get(k), update: async (k, v) => { global.set(k, v); } },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } };
  return { vscode, context, log, global, tabState, answer: (a) => q.push(a) };
}
const stub = (pro = false) => ({ id: 'github-sponsors', ready: Promise.resolve(), isPro: () => pro, unlock: async () => ({ pro: false }), refresh: async () => false, remove: async () => {}, state: () => null, onDidChange: () => ({ dispose() {} }) });
const mk = (f, extra = {}) => IDX.createLicense({
  vscode: f.vscode, context: f.context, sku: 'hex-pro', name: 'Zovo', product: 'Hex Viewer', commandPrefix: 'hexViewer',
  cardBuyUrl: CARD, listing: 'hex', rails: [stub()], sharedFile: '', returnDelayMs: 0, trial: true, env: { ZOVO_TRIAL_TODAY: '2026-11-20' }, ...extra,
});
const day = (d) => ({ ZOVO_TRIAL_TODAY: d });
const TAG = (tag) => new RegExp(`client_reference_id=[0-9a-f-]{36}_${tag}_hex(&|$)`);

test('TRIAL2 module version, labels, prices unchanged', () => {
  assert.match(IDX.MODULE_VERSION, /^2026-11-19\.trial2(-conv3)?$/);
  assert.equal(IDX.TRIAL_LABEL, 'Try all Pro tools for 7 days, free, no card');
  assert.equal(IDX.TRIAL_ENDED_LINE, 'Your trial ended. USD 19 once keeps every Pro tool.');
  assert.equal(IDX.TRIAL_DAYS, 7);
  assert.deepEqual(IDX.PRICE, { one: 19, team: 59, seats: 5 });
});

test('TRIAL2 day math: day 0 = 7 left, day 6 = 1 left, day 7 and 8 ended, year end, February, clock set back', () => {
  const s = IDX.trialStateOf;
  assert.deepEqual([s('2026-11-20', '2026-11-20').left, s('2026-11-20', '2026-11-26').left], [7, 1]);
  assert.equal(s('2026-11-20', '2026-11-26').on, true);
  assert.equal(s('2026-11-20', '2026-11-27').on, false);
  assert.equal(s('2026-11-20', '2026-11-27').ended, true);
  assert.equal(s('2026-11-20', '2026-11-28').ended, true);
  assert.equal(s('2026-11-20', '2026-11-27').end, '2026-11-27');
  assert.equal(s('2026-12-29', '2027-01-04').left, 1);
  assert.equal(s('2026-12-29', '2027-01-05').on, false);
  assert.equal(s('2028-02-25', '2028-03-02').left, 1); // leap year: 25 Feb + 6 days = 2 Mar
  assert.equal(s('2027-02-25', '2027-03-04').on, false);
  assert.equal(s('2026-11-20', '2026-11-19').on, true); // 1 day of slack (time zone change)
  assert.equal(s('2026-11-20', '2026-11-17').on, false); // the clock set back more than 1 day ends it
  assert.equal(s('', '2026-11-20').started, false);
  assert.equal(IDX.trialDaysLeftText(1), 'Pro trial: 1 day left');
  assert.equal(IDX.trialDaysLeftText(7), 'Pro trial: 7 days left');
});

test('TRIAL2 off under node --test unless { trial: true }: the SPON1 panel stays as before (older product tests)', async () => {
  const f = fakeVscode();
  const p = IDX.createLicense({ vscode: f.vscode, context: f.context, sku: 'hex-pro', name: 'Zovo', product: 'Hex Viewer', cardBuyUrl: CARD, listing: 'hex', rails: [stub()], sharedFile: '', returnDelayMs: 0 });
  assert.equal(await p.requirePro('Checksums of File', { detail: 'x' }), false);
  assert.deepEqual(f.log.modal[0].buttons.slice(0, 3), [SP, CB, SD]);
  assert.ok(!f.log.modal[0].buttons.includes(T));
  assert.equal(p.trial.enabled(), false);
});

test('TRIAL2 nothing before a click: no item, no message, no state, no URL at creation', async () => {
  const f = fakeVscode({ tabs: { input: { viewType: 'hexViewer.editor' } } });
  const p = mk(f);
  await p.ready;
  assert.equal(f.log.items.length, 0);
  assert.equal(f.log.info.length + f.log.modal.length + f.log.opened.length, 0);
  assert.equal(f.global.get(IDX.TRIAL_STATE_KEY), undefined);
  assert.equal(p.isPro(), false);
});

test('TRIAL2 the Pro panel: the trial button first, then Sponsors, card, See details; the text says when it ends', async () => {
  const f = fakeVscode();
  const p = mk(f);
  assert.equal(await p.requirePro('Checksums of File', { detail: 'Hashes of the file.' }), false); // Escape: nothing runs
  const m = f.log.modal[0];
  assert.equal(m.msg, 'Checksums of File is part of Zovo Pro.');
  assert.deepEqual(m.buttons, [T, SP, CB, SD, 'Pay with PayPal', 'Enter a key', 'Not now (tell us why)']);
  assert.match(m.detail, /^Try all Pro tools of Hex Viewer for 7 days, free\. No card and no account\. The trial starts only when you click its button\. It ends on its own on 27 Nov 2026\./);
  assert.match(m.detail, /Hashes of the file\./); // the SPON1 panel text follows
  assert.equal(f.log.opened.length, 0);
  assert.equal(f.global.get(IDX.TRIAL_STATE_KEY), undefined); // no start without the click
});

test('TRIAL2 the trial button: the tool runs, all Pro tools work, no try, no notification, the listeners hear it', async () => {
  const f = fakeVscode({ answers: [T] });
  const p = mk(f);
  let heard = 0;
  p.onDidChange(() => { heard++; });
  assert.equal(await p.requirePro('Checksums of File', { detail: 'x' }), true);
  assert.deepEqual(f.global.get(IDX.TRIAL_STATE_KEY).start, '2026-11-20');
  assert.equal(p.isPro(), true);
  assert.equal(p.isPaid(), false);
  assert.equal(heard, 1);
  assert.equal(await p.requirePro('Extract Strings', { detail: 'x' }), true);
  assert.equal(f.log.modal.length, 1); // no second panel
  assert.equal(f.log.info.length, 0); // no toast
  assert.equal(f.log.opened.length, 0);
  assert.equal(p.trial.status().left, 7);
});

test('TRIAL2 tags: the buy links of the trial panel carry _trialstart_<listing>; the tool does not run', async () => {
  const cases = [[SP, /^https:\/\/license\.zovo\.one\/gh\/zovo-pro\?/], [CB, /^https:\/\/license\.zovo\.one\/pay\/zovo-pro\?/], [SD, /^https:\/\/license\.zovo\.one\/buy\/zovo-pro\?/], ['Not now (tell us why)', /^https:\/\/license\.zovo\.one\/buy\/zovo-pro\?nn=1&ref=/]];
  for (const [b, re] of cases) {
    const f = fakeVscode({ answers: [b] });
    const p = mk(f);
    assert.equal(await p.requirePro('Checksums of File', { detail: 'x', surface: 'toolbar' }), false);
    assert.equal(f.log.opened.length, 1, b);
    assert.match(f.log.opened[0], re, b);
    assert.match(f.log.opened[0], b.startsWith('Not now') ? /ref=[0-9a-f-]{36}_trialstart_hex(&|$)/ : TAG('trialstart'), b);
    assert.ok(!/stripe\.com|github\.com/.test(f.log.opened[0]));
    assert.equal(f.global.get(IDX.TRIAL_STATE_KEY), undefined);
  }
});

test('TRIAL2 day 6: still on; day 7: back to the free tries, the end panel one time with _trialend_, then the SPON1 panel', async () => {
  const f = fakeVscode({ answers: [T] });
  const env = day('2026-11-20');
  const p = mk(f, { env });
  assert.equal(await p.requirePro('Checksums of File', { detail: 'x' }), true);
  env.ZOVO_TRIAL_TODAY = '2026-11-26';
  assert.equal(p.isPro(), true);
  assert.equal(p.trial.status().left, 1);
  env.ZOVO_TRIAL_TODAY = '2026-11-27';
  assert.equal(p.isPro(), false);
  f.answer(SP);
  assert.equal(await p.requirePro('Checksums of File', { detail: 'x' }), false);
  const end = f.log.modal[1];
  assert.equal(end.msg, 'Your trial ended. USD 19 once keeps every Pro tool.');
  assert.deepEqual(end.buttons, [SP, CB, SD, 'Enter a key']);
  assert.match(end.detail, /Your 7-day trial of the Hex Viewer Pro tools ended on 27 Nov 2026\. You already used the free try of Checksums of File\./);
  assert.match(end.detail, /Free features stay free\. USD 19 once funds the Pro tools\./);
  assert.match(f.log.opened[0], /^https:\/\/license\.zovo\.one\/gh\/zovo-pro\?/);
  assert.match(f.log.opened[0], TAG('trialend'));
  // the next click: the SPON1 panel with the panel tag, no trial button
  f.answer(CB);
  assert.equal(await p.requirePro('Checksums of File', { detail: 'x' }), false);
  assert.deepEqual(f.log.modal[2].buttons.slice(0, 3), [SP, CB, SD]);
  assert.ok(!f.log.modal[2].buttons.includes(T));
  assert.match(f.log.opened[1], TAG('panel'));
  env.ZOVO_TRIAL_TODAY = '2026-11-28';
  assert.equal(await p.requirePro('Checksums of File', { detail: 'x' }), false);
  assert.equal(f.log.modal.length, 4);
  assert.ok(!f.log.modal[3].buttons.includes(T), 'one trial per install');
});

test('TRIAL2 end panel buttons: card and See details carry _trialend_; Escape opens nothing', async () => {
  for (const [b, re] of [[CB, /\/pay\/zovo-pro\?/], [SD, /\/buy\/zovo-pro\?/], [undefined, null]]) {
    const f = fakeVscode({ answers: [T, b] });
    const env = day('2026-11-20');
    const p = mk(f, { env });
    await p.requirePro('A', { detail: 'x' });
    env.ZOVO_TRIAL_TODAY = '2026-11-27';
    assert.equal(await p.requirePro('A', { detail: 'x' }), false);
    if (!re) { assert.equal(f.log.opened.length, 0); continue; }
    assert.equal(f.log.opened.length, 1);
    assert.match(f.log.opened[0], re);
    assert.match(f.log.opened[0], TAG('trialend'));
  }
});

test('TRIAL2 the state survives a restart (globalState); a key still wins after the end', async () => {
  const f = fakeVscode({ answers: [T] });
  await mk(f).requirePro('A', { detail: 'x' });
  const again = mk(f, { env: day('2026-11-23') });
  assert.equal(again.isPro(), true);
  assert.equal(again.trial.status().left, 4);
  const paid = mk(f, { env: day('2026-12-30'), rails: [stub(true)] });
  assert.equal(paid.isPro(), true);
  assert.equal(await paid.requirePro('A', { detail: 'x' }), true);
  assert.equal(f.log.modal.length, 1); // no end panel for a key holder
});

test('TRIAL2 kill switch zovo.<listing>.trial.enabled = false: no trial button; a started trial runs to its end', async () => {
  const off = fakeVscode({ setting: false });
  const p = mk(off);
  assert.equal(await p.requirePro('A', { detail: 'x' }), false);
  assert.deepEqual(off.log.modal[0].buttons.slice(0, 3), [SP, CB, SD]);
  assert.match(off.log.modal[0].detail, /^(?!Try all Pro tools)/);
  assert.equal(p.trial.enabled(), false);
  const f = fakeVscode({ answers: [T] });
  await mk(f).requirePro('A', { detail: 'x' });
  const f2 = { ...f, vscode: { ...f.vscode, workspace: { getConfiguration: () => ({ get: () => false }) } } };
  const later = mk(f2, { env: day('2026-11-22') });
  assert.equal(later.isPro(), true);
  // no listing: no trial (no tag possible)
  const n = fakeVscode();
  const q = mk(n, { listing: '' });
  await q.requirePro('A', { detail: 'x' });
  assert.ok(!n.log.modal[0].buttons.includes(T));
});

test('TRIAL2 status item "Pro trial: N days left": only in a trial, only on a tab of this extension', async () => {
  const f = fakeVscode({ answers: [T], tabs: { input: { viewType: 'hexViewer.editor' } } });
  const env = day('2026-11-20');
  const p = mk(f, { env });
  assert.equal(f.log.items.length, 0);
  await p.requirePro('A', { detail: 'x' });
  assert.equal(f.log.items.length, 1);
  const it = f.log.items[0];
  assert.equal(it.text, '$(clock) Pro trial: 7 days left');
  assert.equal(it.shown, true);
  assert.equal(it.command, undefined);
  f.tabState.active = { input: { uri: 'file:///notes.txt' } }; // a text tab
  f.tabState.listeners.forEach((fn) => fn());
  assert.equal(it.shown, false);
  f.tabState.active = { input: { viewType: 'mainThreadWebview-hexViewer.editor' } };
  env.ZOVO_TRIAL_TODAY = '2026-11-26';
  f.tabState.listeners.forEach((fn) => fn());
  assert.equal(it.shown, true);
  assert.equal(it.text, '$(clock) Pro trial: 1 day left');
  env.ZOVO_TRIAL_TODAY = '2026-11-27';
  f.tabState.listeners.forEach((fn) => fn());
  assert.equal(it.shown, false);
  // a restart in the trial: the item comes back at activation, still nothing on open while no tab of ours is active
  const g = fakeVscode({ answers: [T], tabs: { input: { uri: 'file:///a.txt' } } });
  await mk(g).requirePro('A', { detail: 'x' });
  const g2 = { ...g, log: { ...g.log, items: [] } };
  g2.vscode = { ...g.vscode, window: { ...g.vscode.window, createStatusBarItem: (...a) => { const x = g.vscode.window.createStatusBarItem(...a); g2.log.items.push(x); return x; } } };
  mk(g2, { env: day('2026-11-21') });
  assert.equal(g2.log.items.length, 1);
  assert.equal(g2.log.items[0].shown, false);
  assert.equal(g.log.info.length, 0);
});

test('TRIAL2 source: no network, no notification, no telemetry in the trial code', () => {
  const a = SRC.indexOf('// TRIAL2 (wave18, 19 Nov 2026');
  const b = SRC.indexOf('\nconst', SRC.indexOf('function createTrial(o)')) > 0 ? SRC.indexOf('function createTrial(o)') : -1;
  assert.ok(a > 0 && b > a);
  const end = SRC.indexOf('\n}\n', b);
  const block = SRC.slice(a, end);
  assert.ok(!/https?:\/\//.test(block.replace(/\/\/.*$/gm, '')), 'no URL in the trial code');
  assert.ok(!/fetch\(|require\('https?'\)|showInformationMessage|showWarningMessage|showErrorMessage|openExternal/.test(block));
  assert.ok(/TRIAL2-TRIAL/.test(SRC));
});
