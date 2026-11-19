'use strict';
// The value model shared by the three formats, and its JSON forms.
// A value is { t, ... }: null, undef, bool, int (v: BigInt, w: 32 | 64 for BSON), float (v, w: 16 | 32 | 64), str, bin (v: Buffer,
// sub: BSON subtype), arr (v: [value]), map (v: [[key value, value]]), ext (type, v: Buffer), date (s: BigInt seconds, ns),
// tag (tag: BigInt, v), simple (v), oid (v: 12 bytes), regex (p, f), dbptr (ns, id), code (v, scope?), symbol (v),
// bts (tm, i), dec128 (v: 16 bytes), minkey, maxkey.
// - Plain JSON: readable JSON for the viewer and for people (binary as base64, dates as ISO text, ObjectId as hex).
// - Typed JSON: JSON that converts back without loss, with MongoDB Extended JSON style wrappers ($oid, $date,
//   $numberLong, $binary, ...) plus $ext, $tag, $simple, $float32, $float16 and $map (keys that are not text).
// The JSON reader is our own: it keeps integers as BigInt and tells 1 from 1.0, so a typed file reads back exactly.
const { isoOf, parseIso, floatText, fromHex, hex, toF32 } = require('./common');
const { decimalText, decimalBytes } = require('./bson');
const { tagName } = require('./cbor');

const b64 = (b) => Buffer.from(b).toString('base64');
const hex2 = (n) => n.toString(16).padStart(2, '0');

// ---------- JSON text writers ----------
class Writer {
  constructor(indent, max) { this.parts = []; this.len = 0; this.indent = indent; this.max = max || Infinity; this.truncated = false; }
  w(s) { if (this.len > this.max) { this.truncated = true; return; } this.parts.push(s); this.len += s.length; }
  nl(d) { if (this.indent) this.w(`\n${' '.repeat(this.indent * d)}`); }
  text() { return this.parts.join(''); }
}
const q = (s) => JSON.stringify(s);

function writeList(o, items, d, open, close, each) {
  if (!items.length) { o.w(open + close); return; }
  o.w(open);
  items.forEach((x, i) => { if (i) o.w(','); o.nl(d + 1); each(x); if (o.len > o.max) o.truncated = true; });
  o.nl(d); o.w(close);
}
function writeObj(o, pairs, d, val) {
  writeList(o, pairs, d, '{', '}', ([k, v]) => { o.w(q(k)); o.w(o.indent ? ': ' : ':'); val(v); });
}

function uuidText(b) { const h = hex(b, 16, ''); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
function bigOfBytes(b) { return b.length ? BigInt(`0x${hex(b, Infinity, '')}`) : 0n; }
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** Plain JSON (readable). */
function plain(x, o, d = 0) {
  switch (x.t) {
    case 'null': case 'undef': o.w('null'); return;
    case 'bool': o.w(x.v ? 'true' : 'false'); return;
    case 'int': o.w(x.v.toString()); return;
    case 'float': o.w(Number.isFinite(x.v) ? floatText(x.v).replace(/\.0$/, '') : q(floatText(x.v))); return;
    case 'str': case 'code': case 'symbol': if (x.t === 'code' && x.scope) { writeObj(o, [['$code', { t: 'str', v: x.v }], ['$scope', x.scope]], d, (v) => plain(v, o, d + 1)); return; } o.w(q(x.v)); return;
    case 'bin': o.w(q(b64(x.v))); return;
    case 'arr': writeList(o, x.v, d, '[', ']', (v) => plain(v, o, d + 1)); return;
    case 'map': writeObj(o, x.v.map(([k, v]) => [keyText(k), v]), d, (v) => plain(v, o, d + 1)); return;
    case 'ext': writeObj(o, [['$ext', { t: 'map', v: [[{ t: 'str', v: 'type' }, { t: 'int', v: BigInt(x.type) }], [{ t: 'str', v: 'base64' }, { t: 'str', v: b64(x.v) }]] }]], d, (v) => plain(v, o, d + 1)); return;
    case 'date': { const s = isoOf(x.s, x.ns); o.w(s ? q(s) : x.s.toString()); return; }
    case 'tag': {
      const n = Number(x.tag);
      if (n === 1 && (x.v.t === 'int' || x.v.t === 'float')) { const s = epochIso(x.v); if (s) { o.w(q(s)); return; } }
      if ((n === 2 || n === 3) && x.v.t === 'bin') { const b = bigOfBytes(x.v.v); o.w((n === 2 ? b : -1n - b).toString()); return; }
      if (n === 37 && x.v.t === 'bin' && x.v.v.length === 16) { o.w(q(uuidText(x.v.v))); return; }
      plain(x.v, o, d); return;
    }
    case 'simple': o.w(String(x.v)); return;
    case 'oid': o.w(q(hex(x.v, 12, ''))); return;
    case 'regex': o.w(q(`/${x.p}/${x.f}`)); return;
    case 'dbptr': writeObj(o, [['$ref', { t: 'str', v: x.ns }], ['$id', { t: 'str', v: hex(x.id, 12, '') }]], d, (v) => plain(v, o, d + 1)); return;
    case 'bts': writeObj(o, [['t', { t: 'int', v: BigInt(x.tm) }], ['i', { t: 'int', v: BigInt(x.i) }]], d, (v) => plain(v, o, d + 1)); return;
    case 'dec128': { const s = decimalText(x.v); o.w(JSON_NUMBER.test(s) ? s : q(s)); return; }
    case 'minkey': o.w(o.indent ? '{ "$minKey": 1 }' : '{"$minKey":1}'); return;
    case 'maxkey': o.w(o.indent ? '{ "$maxKey": 1 }' : '{"$maxKey":1}'); return;
    default: o.w('null');
  }
}
function epochIso(v) {
  if (v.t === 'int') return isoOf(v.v, 0);
  if (!Number.isFinite(v.v)) return '';
  const s = Math.floor(v.v);
  return isoOf(BigInt(s), Math.round((v.v - s) * 1e9));
}

/** A map key as text (plain JSON object keys). */
function keyText(k) {
  if (k.t === 'str') return k.v;
  if (k.t === 'int') return k.v.toString();
  const o = new Writer(0);
  plain(k, o);
  return o.text();
}

// typed JSON: wrapper names a real map must not start with (such maps are written as $map)
const WRAPPERS = new Set(['$oid', '$date', '$numberLong', '$numberInt', '$numberDouble', '$numberDecimal', '$float32', '$float16', '$binary', '$ext', '$tag', '$simple', '$undefined', '$regularExpression', '$minKey', '$maxKey', '$timestamp', '$code', '$symbol', '$dbPointer', '$map']);
const S = (v) => ({ t: 'str', v });
const I = (v) => ({ t: 'int', v: BigInt(v) });
const M = (...pairs) => ({ t: 'map', v: pairs.map(([k, v]) => [S(k), v]) });

/** Typed JSON: the value as a JSON-able value of plain types (map keys text), with wrappers for the rest. */
function typedForm(x) {
  switch (x.t) {
    case 'null': case 'bool': case 'str': return x;
    case 'undef': return M(['$undefined', { t: 'bool', v: true }]);
    case 'int': return x.w === 64 ? M(['$numberLong', S(x.v.toString())]) : { t: 'int', v: x.v };
    case 'float': {
      if (x.w === 32 || x.w === 16) return M([x.w === 32 ? '$float32' : '$float16', Number.isFinite(x.v) ? { t: 'float', v: x.v } : S(floatText(x.v))]);
      return Number.isFinite(x.v) ? x : M(['$numberDouble', S(floatText(x.v))]);
    }
    case 'bin': return M(['$binary', M(['base64', S(b64(x.v))], ['subType', S(hex2(x.sub || 0))])]);
    case 'arr': return { t: 'arr', v: x.v.map(typedForm) };
    case 'map': {
      const textKeys = x.v.every(([k]) => k.t === 'str');
      if (textKeys && !(x.v.length && x.v.length <= 2 && WRAPPERS.has(x.v[0][0].v))) return { t: 'map', v: x.v.map(([k, v]) => [k, typedForm(v)]) };
      return M(['$map', { t: 'arr', v: x.v.map(([k, v]) => ({ t: 'arr', v: [typedForm(k), typedForm(v)] })) }]);
    }
    case 'ext': return M(['$ext', M(['type', I(x.type)], ['base64', S(b64(x.v))])]);
    case 'date': { const s = isoOf(x.s, x.ns); return s ? M(['$date', S(s)]) : M(['$date', M(['$numberLong', S((BigInt(x.s) * 1000n + BigInt(Math.floor((x.ns || 0) / 1e6))).toString())])]); }
    case 'tag': return M(['$tag', { t: 'int', v: BigInt(x.tag) }], ['value', typedForm(x.v)]);
    case 'simple': return M(['$simple', I(x.v)]);
    case 'oid': return M(['$oid', S(hex(x.v, 12, ''))]);
    case 'regex': return M(['$regularExpression', M(['pattern', S(x.p)], ['options', S(x.f)])]);
    case 'dbptr': return M(['$dbPointer', M(['$ref', S(x.ns)], ['$id', M(['$oid', S(hex(x.id, 12, ''))])])]);
    case 'code': return x.scope ? M(['$code', S(x.v)], ['$scope', typedForm(x.scope)]) : M(['$code', S(x.v)]);
    case 'symbol': return M(['$symbol', S(x.v)]);
    case 'bts': return M(['$timestamp', M(['t', I(x.tm)], ['i', I(x.i)])]);
    case 'dec128': return M(['$numberDecimal', S(decimalText(x.v))]);
    case 'minkey': return M(['$minKey', I(1)]);
    case 'maxkey': return M(['$maxKey', I(1)]);
    default: throw new Error(`Unknown value type ${x.t}`);
  }
}
function writeTypedForm(x, o, d) {
  switch (x.t) {
    case 'null': o.w('null'); return;
    case 'bool': o.w(x.v ? 'true' : 'false'); return;
    case 'int': o.w(x.v.toString()); return;
    case 'float': o.w(floatText(x.v)); return;
    case 'str': o.w(q(x.v)); return;
    case 'arr': writeList(o, x.v, d, '[', ']', (v) => writeTypedForm(v, o, d + 1)); return;
    case 'map': writeObj(o, x.v.map(([k, v]) => [k.v, v]), d, (v) => writeTypedForm(v, o, d + 1)); return;
    default: throw new Error(`typed form ${x.t}`);
  }
}

/** JSON text of a value. mode 'plain' | 'typed'; indent 0 = one line. { text, truncated }. */
function toJson(x, { mode = 'plain', indent = 2, max } = {}) {
  const o = new Writer(indent, max);
  if (mode === 'typed') writeTypedForm(typedForm(x), o, 0); else plain(x, o, 0);
  return { text: o.text(), truncated: o.truncated };
}
const compact = (x) => toJson(x, { mode: 'typed', indent: 0 }).text;

// ---------- JSON reader (our own: BigInt integers, 1 and 1.0 kept apart, keys in order) ----------
class JsonError extends Error { constructor(msg, pos, text) { const lc = lineCol(text, pos); super(`${msg} at line ${lc.line}, column ${lc.col}`); this.pos = pos; this.line = lc.line; this.col = lc.col; } }
function lineCol(text, pos) { let line = 1; let last = -1; for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) { line++; last = i; } return { line, col: pos - last }; }

function parseJsonValues(text, { many = false } = {}) {
  let p = 0;
  const n = text.length;
  const ws = () => { while (p < n) { const c = text.charCodeAt(p); if (c === 32 || c === 9 || c === 10 || c === 13 || c === 0xfeff) p++; else break; } };
  const err = (m) => { throw new JsonError(m, p, text); };
  function str() {
    p++;
    let out = '';
    let s = p;
    for (;;) {
      if (p >= n) err('Unclosed string');
      const c = text.charCodeAt(p);
      if (c === 34) { out += text.slice(s, p); p++; return out; }
      if (c < 32) err('Control character in a string');
      if (c === 92) {
        out += text.slice(s, p);
        const e = text[p + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e in map) { out += map[e]; p += 2; } else if (e === 'u') { const h = text.slice(p + 2, p + 6); if (!/^[0-9a-fA-F]{4}$/.test(h)) err('Bad \\u escape'); out += String.fromCharCode(parseInt(h, 16)); p += 6; } else err('Bad escape');
        s = p;
      } else p++;
    }
  }
  function value(depth) {
    if (depth > 1000) err('Nested too deep');
    ws();
    if (p >= n) err('Unexpected end of the text');
    const c = text[p];
    if (c === '{') {
      p++; const pairs = []; ws();
      if (text[p] === '}') { p++; return { t: 'map', v: pairs }; }
      for (;;) {
        ws(); if (text[p] !== '"') err('Expected a key in double quotes');
        const k = str(); ws(); if (text[p] !== ':') err('Expected ":"'); p++;
        pairs.push([{ t: 'str', v: k }, value(depth + 1)]); ws();
        if (text[p] === ',') { p++; continue; }
        if (text[p] === '}') { p++; return { t: 'map', v: pairs }; }
        err('Expected "," or "}"');
      }
    }
    if (c === '[') {
      p++; const items = []; ws();
      if (text[p] === ']') { p++; return { t: 'arr', v: items }; }
      for (;;) {
        items.push(value(depth + 1)); ws();
        if (text[p] === ',') { p++; continue; }
        if (text[p] === ']') { p++; return { t: 'arr', v: items }; }
        err('Expected "," or "]"');
      }
    }
    if (c === '"') return { t: 'str', v: str() };
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(p, p + 400));
    if (m && m[0] && m[0] !== '-') { p += m[0].length; return m[1] || m[2] ? { t: 'float', v: Number(m[0]) } : { t: 'int', v: BigInt(m[0]) }; }
    for (const [w, v] of [['true', { t: 'bool', v: true }], ['false', { t: 'bool', v: false }], ['null', { t: 'null' }]]) if (text.startsWith(w, p)) { p += w.length; return v; }
    err(`Unexpected "${c}"`);
    return null;
  }
  const out = [];
  ws();
  if (!many) { out.push(value(0)); ws(); if (p < n) err('Unexpected text after the JSON value'); return out; }
  while (p < n) { out.push(value(0)); ws(); }
  return out;
}

// ---------- typed JSON wrappers back to values ----------
const one = (x, key) => x.t === 'map' && x.v.length === 1 && x.v[0][0].v === key ? x.v[0][1] : null;
const field = (x, key) => { if (x.t !== 'map') return null; const f = x.v.find(([k]) => k.v === key); return f ? f[1] : null; };
const keysAre = (x, ...keys) => x.t === 'map' && x.v.length === keys.length && x.v.every(([k]) => keys.includes(k.v));
const isStr = (x) => x && x.t === 'str';
const numOf = (x) => (x && x.t === 'int' ? Number(x.v) : x && x.t === 'float' ? x.v : x && x.t === 'str' ? Number(x.v === 'Infinity' ? Infinity : x.v === '-Infinity' ? -Infinity : x.v) : NaN);

/** Turns the wrappers of a parsed typed-JSON value into values. Throws Error for a malformed wrapper. */
function fromTyped(x, path = '$') {
  if (x.t === 'arr') return { t: 'arr', v: x.v.map((c, i) => fromTyped(c, `${path}[${i}]`)) };
  if (x.t !== 'map') return x;
  if (x.v.length >= 1 && x.v.length <= 2 && WRAPPERS.has(x.v[0][0].v)) {
    const k = x.v[0][0].v;
    const bad = (what) => { throw new Error(`${path}: ${k} needs ${what}.`); };
    let w;
    if (x.v.length === 1) w = x.v[0][1];
    if (k === '$oid' && w) { const b = isStr(w) && fromHex(w.v); if (!b || b.length !== 12) bad('24 hex digits'); return { t: 'oid', v: b }; }
    if (k === '$date' && w) {
      if (isStr(w)) { const d = parseIso(w.v); if (!d) bad('an ISO 8601 date'); return { t: 'date', s: d.s, ns: d.ns }; }
      const l = one(w, '$numberLong');
      if (isStr(l) && /^-?\d+$/.test(l.v)) { const ms = BigInt(l.v); const s = ms >= 0n ? ms / 1000n : -((-ms + 999n) / 1000n); return { t: 'date', s, ns: Number(ms - s * 1000n) * 1e6 }; }
      if (w.t === 'int') { const ms = w.v; const s = ms >= 0n ? ms / 1000n : -((-ms + 999n) / 1000n); return { t: 'date', s, ns: Number(ms - s * 1000n) * 1e6 }; }
      bad('an ISO 8601 date');
    }
    if (k === '$numberLong' && w) { if (!isStr(w) || !/^-?\d+$/.test(w.v)) bad('integer text'); return { t: 'int', v: BigInt(w.v), w: 64 }; }
    if (k === '$numberInt' && w) { if (!isStr(w) || !/^-?\d+$/.test(w.v)) bad('integer text'); return { t: 'int', v: BigInt(w.v), w: 32 }; }
    if (k === '$numberDouble' && w) { const v = numOf(w); if (Number.isNaN(v) && !(isStr(w) && w.v === 'NaN')) bad('a number'); return { t: 'float', v, w: 64 }; }
    if ((k === '$float32' || k === '$float16') && w) { const v = numOf(w); if (Number.isNaN(v) && !(isStr(w) && w.v === 'NaN')) bad('a number'); return { t: 'float', v: k === '$float32' ? toF32(v) : v, w: k === '$float32' ? 32 : 16 }; }
    if (k === '$numberDecimal' && w) { const b = isStr(w) && decimalBytes(w.v); if (!b) bad('decimal text'); return { t: 'dec128', v: b }; }
    if (k === '$binary' && w) {
      const b = field(w, 'base64'); const st = field(w, 'subType');
      if (!isStr(b)) bad('{ "base64": ..., "subType": ... }');
      return { t: 'bin', v: Buffer.from(b.v, 'base64'), sub: isStr(st) ? parseInt(st.v, 16) || 0 : 0 };
    }
    if (k === '$ext' && w) { const ty = field(w, 'type'); const b = field(w, 'base64'); if (!ty || ty.t !== 'int' || !isStr(b) || ty.v < -128n || ty.v > 127n) bad('{ "type": -128 to 127, "base64": ... }'); return { t: 'ext', type: Number(ty.v), v: Buffer.from(b.v, 'base64') }; }
    if (k === '$tag' && keysAre(x, '$tag', 'value')) { const n = field(x, '$tag'); if (n.t !== 'int' || n.v < 0n) bad('a tag number'); return { t: 'tag', tag: n.v, v: fromTyped(field(x, 'value'), path) }; }
    if (k === '$simple' && w) { if (w.t !== 'int' || w.v < 0n || w.v > 255n || (w.v >= 20n && w.v <= 31n)) bad('0 to 19 or 32 to 255'); return { t: 'simple', v: Number(w.v) }; }
    if (k === '$undefined' && w) return { t: 'undef' };
    if (k === '$regularExpression' && w) { const pt = field(w, 'pattern'); const op = field(w, 'options'); if (!isStr(pt)) bad('{ "pattern", "options" }'); return { t: 'regex', p: pt.v, f: isStr(op) ? op.v : '' }; }
    if (k === '$minKey' && w) return { t: 'minkey' };
    if (k === '$maxKey' && w) return { t: 'maxkey' };
    if (k === '$timestamp' && w) { const tm = field(w, 't'); const i = field(w, 'i'); if (!tm || tm.t !== 'int' || !i || i.t !== 'int') bad('{ "t", "i" }'); return { t: 'bts', tm: Number(tm.v), i: Number(i.v) }; }
    if (k === '$code') { const c = field(x, '$code'); if (!isStr(c)) bad('text'); const sc = field(x, '$scope'); if (x.v.length === 2 && !sc) return mapOf(x, path); return sc ? { t: 'code', v: c.v, scope: fromTyped(sc, path) } : { t: 'code', v: c.v }; }
    if (k === '$symbol' && w) { if (!isStr(w)) bad('text'); return { t: 'symbol', v: w.v }; }
    if (k === '$dbPointer' && w) { const r = field(w, '$ref'); const id = field(w, '$id'); const o = id && one(id, '$oid'); const b = isStr(o) && fromHex(o.v); if (!isStr(r) || !b || b.length !== 12) bad('{ "$ref", "$id": { "$oid" } }'); return { t: 'dbptr', ns: r.v, id: b }; }
    if (k === '$map' && w) {
      if (w.t !== 'arr' || !w.v.every((e) => e.t === 'arr' && e.v.length === 2)) bad('a list of [key, value] pairs');
      return { t: 'map', v: w.v.map((e, i) => [fromTyped(e.v[0], `${path} key ${i}`), fromTyped(e.v[1], `${path}[${i}]`)]) };
    }
  }
  return mapOf(x, path);
}
function mapOf(x, path) { return { t: 'map', v: x.v.map(([k, v]) => [k, fromTyped(v, `${path}.${k.v}`)]) }; }

/** Values of a JSON text (typed wrappers read). jsonl: one value per line. */
function fromJsonText(text, { jsonl = false } = {}) {
  return parseJsonValues(text, { many: jsonl }).map((v) => fromTyped(v));
}

// ---------- lowering: types a format has no form for become their typed-JSON maps ----------
const SUPPORTS = {
  msgpack: new Set(['null', 'undef', 'bool', 'int', 'float', 'str', 'bin', 'arr', 'map', 'ext', 'date']),
  cbor: new Set(['null', 'undef', 'bool', 'int', 'float', 'str', 'bin', 'arr', 'map', 'tag', 'simple', 'date']),
  bson: new Set(['null', 'undef', 'bool', 'int', 'float', 'str', 'bin', 'arr', 'map', 'oid', 'date', 'regex', 'dbptr', 'code', 'symbol', 'bts', 'dec128', 'minkey', 'maxkey']),
};
function lower(x, fmt) {
  const ok = SUPPORTS[fmt];
  if (x.t === 'arr') return { t: 'arr', v: x.v.map((c) => lower(c, fmt)) };
  if (x.t === 'map') {
    if (fmt === 'bson' && !x.v.every(([k]) => k.t === 'str')) return lower(typedForm(x), fmt);
    return { t: 'map', v: x.v.map(([k, v]) => [lower(k, fmt), lower(v, fmt)]) };
  }
  if (x.t === 'tag' && fmt !== 'cbor') {
    const n = Number(x.tag);
    if (n === 0 && x.v.t === 'str') { const d = parseIso(x.v.v); if (d) return { t: 'date', s: d.s, ns: d.ns }; }
    if (n === 1 && (x.v.t === 'int' || x.v.t === 'float')) { if (x.v.t === 'int') return { t: 'date', s: x.v.v, ns: 0 }; if (Number.isFinite(x.v.v)) { const s = Math.floor(x.v.v); return { t: 'date', s: BigInt(s), ns: Math.round((x.v.v - s) * 1e9) % 1e9 }; } }
    if ((n === 2 || n === 3) && x.v.t === 'bin') { const b = bigOfBytes(x.v.v); const v = n === 2 ? b : -1n - b; if (v >= -(2n ** 63n) && v < 2n ** 64n && !(fmt === 'bson' && v >= 2n ** 63n)) return { t: 'int', v }; }
  }
  if (x.t === 'tag' && fmt === 'cbor') return { t: 'tag', tag: x.tag, v: lower(x.v, fmt) };
  if (x.t === 'code' && x.scope && fmt === 'bson') return { t: 'code', v: x.v, scope: lower(x.scope, fmt) };
  if (ok.has(x.t)) return x;
  return lower(typedForm(x), fmt);
}

// ---------- short text of a value (comparison report, edit box) ----------
function short(x, max = 120) {
  let s;
  switch (x.t) {
    case 'str': s = q(x.v); break;
    case 'bin': s = `${x.v.length} bytes: ${hex(x.v, 24)}${x.v.length > 24 ? ' ...' : ''}`; break;
    case 'arr': s = `[${x.v.length} ${x.v.length === 1 ? 'item' : 'items'}]`; break;
    case 'map': s = `{${x.v.length} ${x.v.length === 1 ? 'key' : 'keys'}}`; break;
    case 'date': s = isoOf(x.s, x.ns) || `${x.s} s`; break;
    case 'oid': s = `ObjectId(${hex(x.v, 12, '')})`; break;
    case 'float': s = floatText(x.v); break;
    case 'int': s = x.v.toString(); break;
    case 'ext': s = `ext ${x.type}, ${x.v.length} bytes: ${hex(x.v, 16)}`; break;
    case 'tag': s = `tag ${x.tag}${tagName(x.tag) ? ` (${tagName(x.tag)})` : ''}: ${short(x.v, max)}`; break;
    case 'dec128': s = decimalText(x.v); break;
    default: s = compact(x);
  }
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** A readable name of the type of a value. */
function typeName(x) {
  const names = { null: 'null', undef: 'undefined', bool: 'boolean', int: 'integer', float: 'float', str: 'text', bin: 'binary', arr: 'array', map: 'map', ext: 'ext', date: 'date', tag: 'tag', simple: 'simple', oid: 'ObjectId', regex: 'regex', dbptr: 'DBPointer', code: 'code', symbol: 'symbol', bts: 'timestamp', dec128: 'decimal128', minkey: 'MinKey', maxkey: 'MaxKey' };
  if (x.t === 'int' && x.w) return `int${x.w}`;
  if (x.t === 'float' && x.w && x.w !== 64) return `float${x.w}`;
  if (x.t === 'tag') return `tag ${x.tag}`;
  return names[x.t] || x.t;
}

// ---------- paths ----------
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function childPath(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  const k = key.t === 'str' ? key.v : null;
  if (k !== null && IDENT.test(k)) return parent ? `${parent}.${k}` : k;
  return `${parent}[${k !== null ? q(k) : compact(key)}]`;
}

// ---------- structural comparison ----------
/**
 * Differences between two values. { rows: [{ path, kind: added | removed | changed | type, a, b }], counts, total }.
 * Maps are matched by key (text keys by text, other keys by their typed JSON), arrays by position.
 */
function diff(a, b, { max = 10000, root = '' } = {}) {
  const rows = [];
  const counts = { added: 0, removed: 0, changed: 0, type: 0, same: 0 };
  const add = (r) => { counts[r.kind]++; if (rows.length < max) rows.push(r); };
  const keyId = (k) => (k.t === 'str' ? `s${k.v}` : `j${compact(k)}`);
  const kindOf = (x) => (x.t === 'int' && x.w ? 'int' : x.t);
  function walk(x, y, path) {
    if (kindOf(x) !== kindOf(y)) { add({ path: path || '(root)', kind: 'type', a: `${typeName(x)}: ${short(x)}`, b: `${typeName(y)}: ${short(y)}` }); return; }
    if (x.t === 'map') {
      const bm = new Map();
      for (const [k, v] of y.v) if (!bm.has(keyId(k))) bm.set(keyId(k), [k, v]);
      const seen = new Set();
      for (const [k, v] of x.v) {
        const id = keyId(k);
        if (seen.has(id)) continue;
        seen.add(id);
        const p = childPath(path, k);
        if (!bm.has(id)) add({ path: p, kind: 'removed', a: short(v), b: '' });
        else walk(v, bm.get(id)[1], p);
      }
      for (const [id, [k, v]] of bm) if (!seen.has(id)) add({ path: childPath(path, k), kind: 'added', a: '', b: short(v) });
      return;
    }
    if (x.t === 'arr') {
      const n = Math.min(x.v.length, y.v.length);
      for (let i = 0; i < n; i++) walk(x.v[i], y.v[i], childPath(path, i));
      for (let i = n; i < x.v.length; i++) add({ path: childPath(path, i), kind: 'removed', a: short(x.v[i]), b: '' });
      for (let i = n; i < y.v.length; i++) add({ path: childPath(path, i), kind: 'added', a: '', b: short(y.v[i]) });
      return;
    }
    if (x.t === 'tag' && x.tag === y.tag) { walk(x.v, y.v, path); return; }
    // numbers compare by value: a float32 and a float64 (or an int32 and an int64) holding the same number are the same
    const same = x.t === 'float' ? (x.v === y.v && Object.is(x.v, 0) === Object.is(y.v, 0)) || (Number.isNaN(x.v) && Number.isNaN(y.v)) : x.t === 'int' ? x.v === y.v : compact(x) === compact(y);
    if (same) { counts.same++; return; }
    add({ path: path || '(root)', kind: 'changed', a: short(x), b: short(y) });
  }
  walk(a, b, root);
  const total = counts.added + counts.removed + counts.changed + counts.type;
  return { rows, counts, total, truncated: total > rows.length };
}

module.exports = {
  toJson, compact, plain, typedForm, parseJsonValues, fromTyped, fromJsonText, JsonError, lower, short, typeName, childPath, diff, keyText,
  uuidText, bigOfBytes, epochIso, WRAPPERS, SUPPORTS,
};
