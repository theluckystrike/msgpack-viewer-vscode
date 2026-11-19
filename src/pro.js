'use strict';
// Zovo Pro for MsgPack Viewer & BSON, CBOR, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh; this file follows the REG File Editor listing's pro.js). Four Pro tools, 1 free
// try each on this computer. A try counts only after the tool showed its result (the converted file written, the
// edited file saved, the comparison drawn, the batch results drawn); Escape, Cancel or an error never uses one. Every
// click on a Pro tool checks the count again, whatever the file: the 2nd use opens the Pro panel, on the same file
// or another one. Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool
// with no tries left. The 7-day trial (module TRIAL2) starts only from that panel's first button.
const { createLicense } = require('./license');
const { currentSurface } = require('./reach');

const SKU = 'msgpack-viewer-pro';
// OWNER DECISION 15 Nov (TRIES1): 1 free try per Pro tool. The only place this listing sets the number.
const TRIES = 1;
const TRIAL_KEY = 'msgpackViewer.proTrial';

const FEATURES = {
  convert: {
    title: 'Convert to JSON and from JSON',
    detail: 'Saves a MessagePack, CBOR or BSON file as JSON (plain, or typed so it converts back without loss), JSON Lines, or one of the other two formats, and turns a JSON or JSON Lines file into MessagePack, CBOR or BSON.',
  },
  edit: {
    title: 'Edit a value and save',
    detail: 'Changes one value (text, number, boolean, date, ObjectId, binary) and writes it back to the file in the same format. Every other value keeps its exact bytes (in BSON, the lengths of the documents around it are updated).',
  },
  compare: {
    title: 'Compare two files',
    detail: 'A structural comparison of two MessagePack, CBOR or BSON files (also across formats): keys added and removed, changed values and changed types, with each path, saved as a Markdown report.',
  },
  batch: {
    title: 'Batch convert a folder to JSON',
    detail: 'Converts every .msgpack, .mpk, .cbor and .bson file in a folder (and its subfolders if you like) to JSON files next to them, with a result line per file.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function surfaceOf(arg) {
  const s = currentSurface();
  if (s) return s;
  if (arg && typeof arg === 'object' && typeof arg.surface === 'string') return arg.surface;
  return undefined;
}

function createPro({ vscode, context, license, prefix = 'msgpackViewer', productName = 'MsgPack Viewer' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  // Counts never go down in a session: globalState can hand back an older value for a moment after a write, so the
  // highest count seen here wins.
  const seen = {};
  const used = (f) => Math.max(Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0, seen[f] || 0);
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed or in the trial, or a free try left). Otherwise the one panel. */
  async function allowed(f, arg) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    const surface = surfaceOf(arg);
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, toolId: f, triesUsed: used(f), ...(surface ? { surface } : {}) }));
  }

  /** After the tool showed its result: counts one free try (nothing when licensed or in the trial). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    for (const k of Object.keys(seen)) m[k] = Math.max(Number(m[k]) || 0, seen[k]);
    m[f] = used(f) + 1;
    seen[f] = m[f];
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIES, TRIAL_USES: TRIES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left, used,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIES, TRIAL_USES: TRIES, TRIAL_KEY, TOOLS, surfaceOf };
