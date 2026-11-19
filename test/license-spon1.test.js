// SPON1 (18 Nov 2026): "Pay with GitHub Sponsors (USD 19 once)" first in the Pro panel, the card button second,
// "See details" third. The Sponsors button opens the license Worker /gh/ link with the panel tag. No network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
// factory/sprint/license/test or a listing's test/ folder (module in src/license or src/zovo)
const dir = '../src/license'; // this listing keeps the module in src/license
const IDX = require(`${dir}/index.js`);

const CARD = 'https://license.zovo.one/buy/zovo-pro';
function fakeVscode({ answer, infoAnswer } = {}) {
  const log = { modal: [], info: [], opened: [], commands: {} };
  const global = new Map();
  const vscode = {
    Uri: { parse: (s) => ({ toString: () => s, s }) },
    env: { openExternal: async (u) => { log.opened.push(u.toString()); return true; }, language: 'en', uriScheme: 'vscode', appName: 'Visual Studio Code' },
    window: {
      showInformationMessage: async (msg, ...rest) => {
        if (rest[0] && rest[0].modal) { log.modal.push({ msg, detail: rest[0].detail, buttons: rest.slice(1) }); return answer; }
        log.info.push({ msg, buttons: rest }); return infoAnswer;
      },
      showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
      showQuickPick: async () => undefined, showInputBox: async () => undefined,
      onDidChangeWindowState: (fn) => { log.onWindow = fn; return { dispose() {} }; },
      createWebviewPanel: undefined,
    },
    commands: { registerCommand: (id, fn) => { log.commands[id] = fn; return { dispose() {} }; }, executeCommand: async () => undefined },
    extensions: { all: [] },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    authentication: { getSession: async () => undefined },
  };
  const context = { subscriptions: [], extension: { id: 'zovo.zovo-hex-viewer', packageJSON: { version: '9.9.9' } },
    globalState: { get: (k) => global.get(k), update: async (k, v) => { global.set(k, v); } },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } };
  return { vscode, context, log };
}
let unlocks = 0;
const stub = () => ({ id: 'github-sponsors', ready: Promise.resolve(), isPro: () => false, unlock: async () => { unlocks++; return { pro: false }; }, refresh: async () => false, remove: async () => {}, state: () => null, onDidChange: () => ({ dispose() {} }) });
const mk = (f, extra = {}) => IDX.createLicense({
  vscode: f.vscode, context: f.context, sku: 'hex-pro', name: 'Zovo', product: 'Hex Viewer', commandPrefix: 'hexViewer',
  cardBuyUrl: CARD, listing: 'hex', rails: [stub()], sharedFile: '', returnDelayMs: 0, ...extra,
});

test('SPON1 module version, label, same price', () => {
  assert.equal(IDX.MODULE_VERSION, '2026-11-19.trial2');
  assert.equal(IDX.PANEL_SPONSORS_LABEL, 'Pay with GitHub Sponsors (USD 19 once)');
  assert.deepEqual(IDX.PRICE, { one: 19, team: 59, seats: 5 });
  assert.equal(IDX.SPONSORS_ONE_TIME, 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878');
});

test('SPON1 panel order: GitHub Sponsors first, card second, See details third', async () => {
  const f = fakeVscode();
  const p = mk(f);
  await p.ready;
  assert.deepEqual(p.buttons(), ['Pay with GitHub Sponsors (USD 19 once)', 'Pay USD 19 by card', 'See details', 'Pay with PayPal', 'Enter a key', 'Not now (tell us why)']);
  assert.equal(await p.requirePro('Checksums of File', { detail: 'x' }), false);
  assert.deepEqual(f.log.modal[0].buttons.slice(0, 3), ['Pay with GitHub Sponsors (USD 19 once)', 'Pay USD 19 by card', 'See details']);
  assert.ok(!f.log.modal[0].buttons.includes('Get Zovo Pro with GitHub Sponsors'), 'one Sponsors button only');
});

test('SPON1 Sponsors button: the Worker /gh/ link with the panel tag from every surface; nothing from stripe.com or github.com directly', async () => {
  for (const surface of [undefined, 'toolbar', 'ctx', 'pick', 'status']) {
    const f = fakeVscode({ answer: 'Pay with GitHub Sponsors (USD 19 once)' });
    const p = mk(f);
    await p.ready;
    assert.equal(await p.requirePro('Checksums of File', { detail: 'x', surface }), false);
    assert.equal(f.log.opened.length, 1);
    assert.match(f.log.opened[0], /^https:\/\/license\.zovo\.one\/gh\/zovo-pro\?client_reference_id=[0-9a-f-]{36}_panel_hex(&lang=[a-z-]+)?$/);
    assert.equal(p.panelSponsorsUrl(), f.log.opened[0]);
  }
  const t = fakeVscode({ answer: 'Pay with GitHub Sponsors (USD 19 once)' });
  await mk(t, { cardBuyUrl: 'https://license-test.zovo.one/buy/zovo-pro' }).requirePro('X', { detail: 'x' });
  assert.match(t.log.opened[0], /^https:\/\/license-test\.zovo\.one\/gh\/zovo-pro\?/);
});

test('SPON1 back from GitHub: the message offers "Unlock with GitHub Sponsors" (the self-serve unlock)', async () => {
  unlocks = 0;
  const f = fakeVscode({ answer: 'Pay with GitHub Sponsors (USD 19 once)', infoAnswer: 'Unlock with GitHub Sponsors' });
  const p = mk(f);
  await p.ready;
  await p.requirePro('Checksums of File', { detail: 'x' });
  assert.equal(typeof f.log.onWindow, 'function');
  await f.log.onWindow({ focused: false });
  await f.log.onWindow({ focused: true });
  const back = f.log.info.find((m) => /^Back from GitHub Sponsors\?/.test(m.msg));
  assert.ok(back, 'return message');
  assert.equal(back.buttons[0], 'Unlock with GitHub Sponsors');
  assert.equal(unlocks, 1);
});

test('SPON1 card and See details buttons work as before', async () => {
  const c = fakeVscode({ answer: 'Pay USD 19 by card' });
  await mk(c).requirePro('Checksums of File', { detail: 'x', surface: 'toolbar' });
  assert.match(c.log.opened[0], /^https:\/\/license\.zovo\.one\/pay\/zovo-pro\?client_reference_id=[0-9a-f-]{36}_panel_hex$/);
  const d = fakeVscode({ answer: 'See details' });
  await mk(d).requirePro('Checksums of File', { detail: 'x', surface: 'toolbar' });
  assert.match(d.log.opened[0], /^https:\/\/license\.zovo\.one\/buy\/zovo-pro\?client_reference_id=[0-9a-f-]{36}_toolbar_hex&lang=en$/);
});

test('SPON1 nothing opens on its own; a direct Stripe link or no card link keeps the old panels', async () => {
  const f = fakeVscode({ answer: 'Pay with GitHub Sponsors (USD 19 once)' });
  const p = mk(f);
  await p.ready;
  p.noteOpen('file:///a/b.bin');
  assert.equal(f.log.modal.length + f.log.info.length + f.log.opened.length, 0);
  const s = mk(fakeVscode(), { cardBuyUrl: 'https://buy.stripe.com/test_eVq3cw2oagsgeklaYZ43S0Q' });
  assert.deepEqual(s.buttons().slice(0, 2), ['Pay by card (USD 19)', 'Get Zovo Pro with GitHub Sponsors']);
  assert.equal(s.panelSponsorsUrl(), '');
  assert.deepEqual(mk(fakeVscode(), { cardBuyUrl: '' }).buttons(), ['Get Zovo Pro, USD 19', 'Pay with PayPal', 'I already paid']);
  // no Sponsors payment link configured: no Sponsors button
  assert.ok(!mk(fakeVscode(), { paymentUrl: '' }).buttons().includes('Pay with GitHub Sponsors (USD 19 once)'));
});
