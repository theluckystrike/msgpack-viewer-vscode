'use strict';
// What the viewer shows of one file, without vscode: a session over the file bytes with node ids for the tree
// (children read on demand, 500 at a time), one-line previews, the details of a node, search, JSON of a node and
// the chain of a node for an edit. Used by src/editor.js and by the unit tests.
const C = require('./common');
const W = require('./walk');
const V = require('./value');
const { decimalText, SUBTYPES } = require('./bson');

const PAGE = 500;
const NAMES = { msgpack: 'MessagePack', cbor: 'CBOR', bson: 'BSON' };
const EXT_FMT = { msgpack: 'msgpack', mpk: 'msgpack', cbor: 'cbor', bson: 'bson' };
const fmtOfName = (name) => EXT_FMT[(/\.([^.]+)$/.exec(String(name).toLowerCase()) || [])[1]] || null;

const q = (s) => JSON.stringify(s);
const cut = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

function oidTime(b) { return C.isoOf(BigInt(b.readUInt32BE(0)), 0); }

/** One-line preview of an item. kid(item) gives the item inside a tag (for well-known tags). */
function preview(item, kid, count) {
  switch (item.kind) {
    case 'map': { const n = count(item); return n < 0 ? '{ ... }' : `{${n.toLocaleString('en-US')} ${n === 1 ? 'key' : 'keys'}}`; }
    case 'array': { const n = count(item); return n < 0 ? '[ ... ]' : `[${n.toLocaleString('en-US')} ${n === 1 ? 'item' : 'items'}]`; }
    case 'codews': return 'code with scope';
    case 'tag': {
      const c = kid(item);
      const n = Number(item.tag);
      if (c) {
        if (n === 1 && (c.kind === 'int' || c.kind === 'float')) { const s = V.epochIso(c.kind === 'int' ? { t: 'int', v: c.v } : { t: 'float', v: c.v }); if (s) return s; }
        if (n === 0 && c.kind === 'str') return cut(c.v);
        if ((n === 2 || n === 3) && c.kind === 'bin') { const b = V.bigOfBytes(c.v); return (n === 2 ? b : -1n - b).toString(); }
        if (n === 37 && c.kind === 'bin' && c.v.length === 16) return V.uuidText(c.v);
        return `${item.tagName ? `${item.tagName}: ` : ''}${preview(c, kid, count)}`;
      }
      return item.tagName || `tag ${item.tag}`;
    }
    case 'str': return cut(q(item.v));
    case 'code': case 'symbol': return cut(item.v);
    case 'bin': {
      if (item.sub === 4 && item.v.length === 16) return V.uuidText(item.v);
      return item.v.length ? `${item.v.length.toLocaleString('en-US')} bytes: ${C.hex(item.v, 16)}${item.v.length > 16 ? ' ...' : ''}` : '0 bytes';
    }
    case 'int': return item.v.toString();
    case 'float': return C.floatText(item.v);
    case 'bool': return item.v ? 'true' : 'false';
    case 'null': return 'null';
    case 'undefined': return 'undefined';
    case 'ext': return `type ${item.etype}, ${item.v.length} ${item.v.length === 1 ? 'byte' : 'bytes'}${item.v.length ? `: ${C.hex(item.v, 16)}${item.v.length > 16 ? ' ...' : ''}` : ''}`;
    case 'date': return C.isoOf(item.v.s, item.v.ns) || `${item.v.s} seconds since 1970`;
    case 'simple': return `simple(${item.v})`;
    case 'oid': return C.hex(item.v, 12, '');
    case 'regex': return `/${item.v.p}/${item.v.f}`;
    case 'dbptr': return `${item.v.ns} ${C.hex(item.v.id, 12, '')}`;
    case 'bts': return `t=${item.v.t}, i=${item.v.i}`;
    case 'dec128': return item.v;
    case 'minkey': return 'MinKey';
    case 'maxkey': return 'MaxKey';
    default: return '';
  }
}

/** A note when the bytes are text, not binary data (a Git LFS pointer, JSON text), else ''. */
function textHint(buf, fmt) {
  const head = buf.subarray(0, 512);
  if (head.toString('latin1').startsWith('version https://git-lfs.github.com/spec')) return `This is a Git LFS pointer file: a short text file that stands in for the real file, which was not downloaded. It holds no ${NAMES[fmt]} data. Run git lfs pull to get the real file.`;
  let text = 0;
  for (const b of head) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc2) text++;
  const first = head.toString('latin1').replace(/^\ufeff|^\xef\xbb\xbf/, '').trimStart()[0];
  if (head.length >= 2 && text >= head.length * 0.97) {
    if (first === '{' || first === '[') return `This file holds JSON text, not ${NAMES[fmt]} bytes (it starts with "${first}"). Open it as text to read it.`;
    return `This file looks like plain text, not ${NAMES[fmt]} bytes. Open it as text to read it.`;
  }
  return '';
}

class Session {
  /** bytes: the file; fmt: 'msgpack' | 'cbor' | 'bson'. */
  constructor(bytes, fmt, name = '') {
    this.buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength);
    this.fmt = fmt;
    this.name = name;
    this.nodes = new Map();
    this.byPos = new Map();
    this.nextId = 1;
    this.top = W.scanTop(fmt, this.buf);
    this.hint = textHint(this.buf, fmt);
    this.root = { id: 0, depth: -1, path: '', chainIdx: [], scan: this.top, item: { kind: 'stream', end: this.buf.length } };
    this.nodes.set(0, this.root);
  }

  get count() { return this.top.entries.length; }
  get multi() { return this.top.entries.length !== 1 || !!this.top.err; }

  count0(node) {
    const item = node.item;
    if (item.kind === 'map' || item.kind === 'array') {
      if (this.fmt !== 'bson' && item.n >= 0 && !item.indef) return item.n;
      if (item.end < 0) return -1;
      const s = this.scanOf(node);
      return s.err ? -1 : s.entries.length;
    }
    return -1;
  }
  scanOf(node) {
    if (!node.scan) node.scan = W.scan(this.fmt, this.buf, node.item);
    return node.scan;
  }
  /** The child item inside a tag, for previews. */
  tagKid(item) {
    try { const s = W.scan(this.fmt, this.buf, item); return s.entries[0] ? W.itemOf(this.fmt, this.buf, s.entries[0]) : null; } catch (e) { return null; }
  }
  previewOf(node) {
    const tmp = (it) => (it === node.item ? this.count0(node) : this.count0({ item: it }));
    return preview(node.item, (it) => this.tagKid(it), tmp);
  }

  /** The node of child idx of parent (made once; ids stay the same). */
  child(parent, idx, partial) {
    const key = `${parent.id}:${idx}`;
    const known = this.byPos.get(key);
    if (known !== undefined) return this.nodes.get(known);
    const s = parent.scan;
    const entry = partial ? s.partial : s.entries[idx];
    const item = W.itemOf(this.fmt, this.buf, entry, !!partial);
    if (partial) item.broken = true;
    let keyText; let keyKind;
    const pk = parent.item.kind;
    if (parent.id === 0) { keyText = this.multi ? `#${idx + 1}` : '(root)'; keyKind = 'doc'; }
    else if (pk === 'array') { keyText = `[${idx}]`; keyKind = 'index'; }
    else if (pk === 'tag') { keyText = `tag ${parent.item.tag} value`; keyKind = 'index'; }
    else if (this.fmt === 'bson') { keyText = entry.name; keyKind = 'name'; }
    else {
      const k = entry.keyOff !== undefined ? W.keyItemOf(this.fmt, this.buf, entry) : null;
      if (k && k.kind === 'str') { keyText = k.v; keyKind = 'name'; } else { keyText = k ? preview(k, () => null, () => -1) : '?'; keyKind = 'other'; }
    }
    let path;
    if (parent.id === 0) path = this.multi ? `#${idx + 1}` : '';
    else if (pk === 'array') path = `${parent.path}[${idx}]`;
    else if (pk === 'tag') path = parent.path;
    else if (keyKind === 'name') path = V.childPath(parent.path, { t: 'str', v: keyText });
    else path = `${parent.path}[${keyText}]`;
    const node = { id: this.nextId++, parent: parent.id, idx, partial: !!partial, entry, item, key: keyText, keyKind, path, depth: parent.depth + 1, chainIdx: [...parent.chainIdx, partial ? -1 : idx] };
    this.nodes.set(node.id, node);
    this.byPos.set(key, node.id);
    return node;
  }

  hasKids(node) { return W.isContainer(node.item); }

  /** Display row of a node. */
  row(node) {
    const it = node.item;
    const size = it.end >= 0 ? it.end - it.off : -1;
    const keyOff = node.entry && node.entry.keyOff !== undefined && node.entry.keyOff >= 0 ? node.entry.keyOff : -1;
    return {
      id: node.id, key: node.key, keyKind: node.keyKind, type: it.label, kind: it.kind, off: it.off, keyOff, size, depth: node.depth,
      preview: this.previewOf(node), kids: this.hasKids(node), broken: !!(it.broken || (node.entry && node.entry.broken)), bad: !!it.bad,
    };
  }

  /** Rows of the children of node id from start (one page), and the error of that container if any. */
  children(id, start = 0, upTo = 0) {
    const node = this.nodes.get(Number(id));
    if (!node) return { id, rows: [], start, more: false, total: 0, err: null };
    if (node.id !== 0 && !this.hasKids(node)) return { id, rows: [], start, more: false, total: 0, err: null };
    const s = node.id === 0 ? node.scan : this.scanOf(node);
    const total = s.entries.length;
    const end = Math.min(total, Math.max(start + PAGE, upTo + 1));
    const rows = [];
    for (let i = start; i < end; i++) rows.push(this.row(this.child(node, i)));
    const more = end < total;
    let err = null;
    if (!more && s.err) {
      if (s.partial) rows.push(this.row(this.child(node, total, true)));
      err = { off: s.err.off, message: s.err.message };
    }
    return { id: node.id, rows, start, more, total, err };
  }

  /** Full details of a node for the side panel. */
  details(id) {
    const node = this.nodes.get(Number(id));
    if (!node || node.id === 0) return null;
    const it = node.item;
    const size = it.end >= 0 ? it.end - it.off : -1;
    const facts = [];
    let value = '';
    switch (it.kind) {
      case 'str': case 'code': case 'symbol': value = it.v.length > 100000 ? `${it.v.slice(0, 100000)}\n... (${it.v.length.toLocaleString('en-US')} characters in all; Copy value copies all)` : it.v; facts.push(['Length', `${C.plural(it.len, 'byte', 'bytes')} of UTF-8, ${C.plural([...it.v].length, 'character', 'characters')}`]); if (it.bad) facts.push(['Note', 'These bytes are not valid UTF-8; the bad bytes show as �.']); break;
      case 'bin': value = C.hex(it.v, 4096); facts.push(['Length', C.plural(it.v.length, 'byte', 'bytes')]); if (it.sub !== undefined) facts.push(['Subtype', `${it.sub} (${SUBTYPES[it.sub] || (it.sub >= 0x80 ? 'user defined' : 'unknown')})`]); if (it.sub === 4 && it.v.length === 16) facts.push(['UUID', V.uuidText(it.v)]); if (it.v.length) facts.push(['Base64', cut(Buffer.from(it.v).toString('base64'), 400)]); break;
      case 'ext': value = C.hex(it.v, 4096); facts.push(['Ext type', String(it.etype)], ['Length', C.plural(it.v.length, 'byte', 'bytes')]); break;
      case 'date': value = C.isoOf(it.v.s, it.v.ns) || `${it.v.s} seconds since 1970`; facts.push(['Seconds since 1970', it.v.s.toString()]); if (it.v.ns) facts.push(['Nanoseconds', String(it.v.ns)]); if (it.ms !== undefined) facts.push(['Milliseconds since 1970', it.ms.toString()]); break;
      case 'oid': value = C.hex(it.v, 12, ''); facts.push(['Created', `${oidTime(it.v)} (from its first 4 bytes)`]); break;
      case 'float': value = C.floatText(it.v); facts.push(['Width', `${it.w} bits`]); break;
      case 'int': value = it.v.toString(); if (it.v >= 0n) facts.push(['Hex', `0x${it.v.toString(16)}`]); break;
      case 'tag': { const c = this.tagKid(it); value = this.previewOf(node); facts.push(['Tag', `${it.tag}${it.tagName ? ` (${it.tagName})` : ''}`]); if (c) facts.push(['Holds', c.label]); break; }
      case 'map': case 'array': case 'codews': { const n = this.count0(node); value = this.previewOf(node); if (n >= 0) facts.push([it.kind === 'array' ? 'Items' : 'Keys', n.toLocaleString('en-US')]); break; }
      case 'dec128': value = it.v; break;
      default: value = this.previewOf(node);
    }
    const hexEnd = size >= 0 ? Math.min(it.end, it.off + 256) : Math.min(this.buf.length, it.off + 64);
    const start = node.entry && node.entry.elemOff !== undefined && node.entry.elemOff >= 0 ? node.entry.elemOff : it.off;
    const dump = [];
    for (let p = start; p < hexEnd; p += 16) dump.push(`${p.toString(16).padStart(8, '0')}  ${C.hex(this.buf.subarray(p, Math.min(p + 16, hexEnd)))}`);
    return {
      id: node.id, path: node.path || '(root)', key: node.key, type: it.label, kind: it.kind, off: it.off, size, hdr: it.hdr,
      elemOff: start !== it.off ? start : -1, value, facts, hex: dump.join('\n'), hexMore: size > 256, broken: !!it.broken,
      editable: EDITABLE.has(it.kind) && it.end >= 0 && !it.broken && !(node.entry && node.entry.elemOff === -1 && this.fmt === 'bson' && node.entry.name !== '$code'),
    };
  }

  /** The value of a node (or of the whole file for id 0): one value, or an array of the top-level values. */
  valueOf(id) {
    const node = this.nodes.get(Number(id));
    if (!node) throw new Error('The value is no longer in the view.');
    if (node.id === 0) {
      if (this.top.err) throw new C.DecodeError(this.top.err.off, this.top.err.message);
      const vals = this.top.entries.map((e) => W.toValue(this.fmt, this.buf, W.itemOf(this.fmt, this.buf, e)));
      return vals.length === 1 ? vals[0] : { t: 'arr', v: vals };
    }
    if (node.item.end < 0) throw new C.DecodeError(node.item.off, 'This value is damaged; see the message above the tree.');
    return W.toValue(this.fmt, this.buf, node.item);
  }

  json(id, { max = 2000000, mode = 'plain' } = {}) {
    try {
      const v = this.valueOf(id);
      const r = V.toJson(v, { mode, indent: 2, max });
      return { text: r.text, truncated: r.truncated };
    } catch (e) {
      return { error: e instanceof C.DecodeError ? `${e.message}` : String(e.message || e) };
    }
  }

  /** [{ item, entry }] from the top-level value down to the node (for spliceValue). */
  chain(id) {
    const out = [];
    let n = this.nodes.get(Number(id));
    while (n && n.id !== 0) { out.unshift({ item: n.item, entry: n.entry }); n = this.nodes.get(n.parent); }
    return out;
  }

  /** Node of an index path from the top (making the nodes on the way). */
  nodeAt(chainIdx) {
    let n = this.root;
    for (const i of chainIdx) {
      const s = n.id === 0 ? n.scan : this.scanOf(n);
      if (i < 0) { if (!s.partial) return null; n = this.child(n, s.entries.length, true); continue; }
      if (i >= s.entries.length) return null;
      n = this.child(n, i);
    }
    return n;
  }

  /**
   * Keys and values that contain q (case-insensitive). { hits: [{ chain, path, key, preview }], more, visited }.
   * Stops at max hits or after ms milliseconds.
   */
  search(query, { max = 500, ms = 8000 } = {}) {
    const needle = String(query).toLowerCase();
    const hits = [];
    if (!needle) return { hits, more: false };
    const t0 = Date.now();
    let visited = 0;
    let more = false;
    const fmt = this.fmt; const buf = this.buf;
    const stack = [{ scan: this.top, chain: [], path: '', kind: 'stream', pos: 0 }];
    while (stack.length) {
      const f = stack[stack.length - 1];
      if (f.pos >= f.scan.entries.length) { stack.pop(); continue; }
      const i = f.pos++;
      const e = f.scan.entries[i];
      if ((++visited & 1023) === 0 && Date.now() - t0 > ms) { more = true; break; }
      let item;
      try { item = W.itemOf(fmt, buf, e); } catch (x) { continue; }
      let key = ''; let path;
      if (f.kind === 'stream') { key = this.multi ? `#${i + 1}` : ''; path = key; }
      else if (f.kind === 'array') { path = `${f.path}[${i}]`; }
      else if (f.kind === 'tag') { path = f.path; }
      else if (fmt === 'bson') { key = e.name; path = V.childPath(f.path, { t: 'str', v: key }); }
      else {
        let k = null; try { k = W.keyItemOf(fmt, buf, e); } catch (x) { k = null; }
        key = k ? (k.kind === 'str' ? k.v : preview(k, () => null, () => -1)) : '';
        path = k && k.kind === 'str' ? V.childPath(f.path, { t: 'str', v: key }) : `${f.path}[${key}]`;
      }
      const chain = [...f.chain, i];
      const container = W.isContainer(item);
      const pv = container ? '' : scalarText(item);
      const keyHit = f.kind === 'map' && key.toLowerCase().includes(needle);
      if (keyHit || (pv && pv.toLowerCase().includes(needle))) {
        if (hits.length >= max) { more = true; break; }
        hits.push({ chain, path: path || '(root)', key, preview: container ? this.previewOf({ item }) : cut(pv, 120), on: keyHit ? 'key' : 'value' });
      }
      if (container) {
        let s;
        try { s = W.scan(fmt, buf, item); } catch (x) { s = null; }
        if (s) stack.push({ scan: s, chain, path, kind: item.kind === 'array' ? 'array' : item.kind === 'tag' ? 'tag' : 'map', pos: 0 });
      }
    }
    return { hits, more, visited };
  }
}
const EDITABLE = new Set(['str', 'int', 'float', 'bool', 'null', 'bin', 'date', 'oid', 'dec128', 'code', 'symbol', 'undefined']);

/** The text search looks in: strings without quotes, numbers, dates, hex of ObjectIds. */
function scalarText(item) {
  switch (item.kind) {
    case 'str': case 'code': case 'symbol': return item.v;
    case 'bin': return item.sub === 4 && item.v.length === 16 ? V.uuidText(item.v) : '';
    default: return preview(item, () => null, () => -1);
  }
}

/** Reads an edit-box text as the new value of a node. { v } or { error }. */
function parseEdit(item, text, fmt) {
  const t = String(text);
  const err = (m) => ({ error: m });
  const typed = () => {
    try { const [x] = V.fromJsonText(t.trim()); return { v: V.lower(x, fmt) }; } catch (e) { return null; }
  };
  switch (item.kind) {
    case 'str': case 'code': case 'symbol': return { v: { t: item.kind === 'str' ? 'str' : item.kind, v: t } };
    case 'int': {
      const s = t.trim().replace(/_/g, '');
      if (/^[+-]?\d+$/.test(s)) return { v: item.w ? { t: 'int', v: BigInt(s), w: item.w } : { t: 'int', v: BigInt(s) } };
      if (/^0x[0-9a-f]+$/i.test(s)) return { v: item.w ? { t: 'int', v: BigInt(s), w: item.w } : { t: 'int', v: BigInt(s) } };
      if (/^[+-]?(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?$/i.test(s)) return { v: { t: 'float', v: Number(s), w: 64 } };
      return typed() || err('Type a whole number (for example 42 or -7), or a JSON value to change the type.');
    }
    case 'float': {
      const s = t.trim();
      if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s) || /^[+-]?(Infinity|NaN)$/.test(s)) {
        const n = /NaN/.test(s) ? NaN : Number(s);
        return { v: { t: 'float', v: item.w === 32 && fmt !== 'bson' ? C.toF32(n) : n, w: fmt === 'bson' ? 64 : item.w } };
      }
      return typed() || err('Type a number (for example 3.25, -1e6, NaN or Infinity), or a JSON value to change the type.');
    }
    case 'date': {
      const d = C.parseIso(t.trim());
      if (d) return { v: { t: 'date', s: d.s, ns: fmt === 'bson' ? Math.floor(d.ns / 1e6) * 1e6 : d.ns } };
      return typed() || err('Type a date as ISO 8601 text, for example 2026-11-19T08:30:00Z.');
    }
    case 'oid': {
      const b = C.fromHex(t.trim());
      if (b && b.length === 12) return { v: { t: 'oid', v: b } };
      return typed() || err('Type an ObjectId as 24 hex digits.');
    }
    case 'bin': {
      const b = C.fromHex(t.trim());
      if (b) return { v: item.sub !== undefined ? { t: 'bin', v: b, sub: item.sub } : { t: 'bin', v: b } };
      return typed() || err('Type the bytes as hex, for example 0a 1b 2c (spaces optional).');
    }
    case 'dec128': {
      const { decimalBytes } = require('./bson');
      const b = decimalBytes(t);
      if (b) return { v: { t: 'dec128', v: b } };
      return typed() || err('Type a decimal number, for example 1250.75.');
    }
    default: return typed() || err('Type a JSON value: true, false, null, a number, "text", or a typed value such as {"$date": "2026-01-01T00:00:00Z"}.');
  }
}

/** The edit box's start text for a node. */
function editText(item) {
  switch (item.kind) {
    case 'str': case 'code': case 'symbol': return item.v;
    case 'bin': return C.hex(item.v, Infinity);
    case 'date': return C.isoOf(item.v.s, item.v.ns);
    case 'oid': return C.hex(item.v, 12, '');
    case 'dec128': return decimalText(item.raw);
    case 'undefined': return 'null';
    default: return preview(item, () => null, () => -1);
  }
}

module.exports = { Session, textHint, preview, parseEdit, editText, fmtOfName, NAMES, PAGE, EXT_FMT, EDITABLE };
