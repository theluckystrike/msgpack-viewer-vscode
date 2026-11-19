'use strict';
// One way through all three formats: the values at the top of a file (a stream of one or more values), the children
// of a map, array, tag or document, full decoding into the value model (value.js), whole-file checks, and the byte
// splice that writes one edited value back in the same format. Errors carry the byte offset (DecodeError).
const { DecodeError, at, plural } = require('./common');
const msgpack = require('./msgpack');
const cbor = require('./cbor');
const bson = require('./bson');
const { Out } = msgpack;

const FORMATS = { msgpack, cbor, bson };
const MAX_DEPTH = 1000;
const isContainer = (item) => item.kind === 'map' || item.kind === 'array' || item.kind === 'tag' || item.kind === 'codews';
const deep = (off) => new DecodeError(off, `The data at ${at(off)} is nested more than ${MAX_DEPTH.toLocaleString('en-US')} levels deep; the viewer stops there.`);

/** End offset of a MessagePack or CBOR item, reading through its children (sets item.end and, if indefinite, item.n). */
function endOf(fmt, buf, item, depth = 0) {
  if (item.end >= 0) return item.end;
  if (depth > MAX_DEPTH) throw deep(item.off);
  let p = item.off + item.hdr;
  if (item.kind === 'tag') {
    const c = fmt.head(buf, p);
    item.end = endOf(fmt, buf, c, depth + 1);
    return item.end;
  }
  const per = item.kind === 'map' ? 2 : 1;
  if (!item.indef) {
    const total = item.n * per;
    if (total > buf.length - p) throw new DecodeError(item.off, `The ${item.label} at ${at(item.off)} says it holds ${plural(item.n, item.kind === 'map' ? 'entry' : 'item', item.kind === 'map' ? 'entries' : 'items')}, but only ${plural(buf.length - p, 'byte is', 'bytes are')} left in the file.`);
    for (let i = 0; i < total; i++) { const c = fmt.head(buf, p); p = endOf(fmt, buf, c, depth + 1); }
  } else {
    let count = 0;
    for (;;) {
      if (p >= buf.length) throw new DecodeError(buf.length, `The file ends early: the indefinite ${item.kind} that starts at ${at(item.off)} has no "break" byte (0xFF).`);
      if (buf[p] === 0xff) { p++; break; }
      const c = fmt.head(buf, p); p = endOf(fmt, buf, c, depth + 1); count++;
    }
    if (item.kind === 'map' && count % 2) throw new DecodeError(p - 1, `The indefinite map that starts at ${at(item.off)} has a key with no value before its "break" byte at ${at(p - 1)}.`);
    item.n = count / per;
  }
  item.end = p;
  return p;
}

/** A value at p, read whole: { item, end }. A container that cannot be read through throws with e.partial = { off }. */
function stepMC(fmt, buf, p, depth) {
  const item = fmt.head(buf, p);
  try { return { item, end: endOf(fmt, buf, item, depth + 1) }; } catch (e) {
    if (e instanceof DecodeError && isContainer(item)) e.partial = e.partial || { off: p };
    throw e;
  }
}

const fail = (entries, e) => { if (!(e instanceof DecodeError)) throw e; return { entries, err: { off: e.offset, message: e.message }, partial: e.partial || null }; };

/** Children of a container item: { entries: [{ off, end, keyOff?, keyEnd?, name?, type?, elemOff? }], err, partial }. */
function scan(fmtId, buf, item, depth = 0) {
  if (fmtId === 'bson') return bson.scan(buf, item);
  const fmt = FORMATS[fmtId];
  const entries = [];
  let p = item.off + item.hdr;
  try {
    if (item.kind === 'tag') { const s = stepMC(fmt, buf, p, depth); entries.push({ off: p, end: s.end }); return { entries, err: null, partial: null }; }
    const isMap = item.kind === 'map';
    // no count check here: a container that claims too many items lists the ones that are there, then the error
    for (let i = 0; item.indef || i < item.n; i++) {
      if (item.indef) {
        if (p >= buf.length) throw new DecodeError(buf.length, `The file ends early: the indefinite ${item.kind} that starts at ${at(item.off)} has no "break" byte (0xFF).`);
        if (buf[p] === 0xff) { p++; break; }
      }
      if (isMap) {
        const k = stepMC(fmt, buf, p, depth);
        if (item.indef && buf[k.end] === 0xff) throw new DecodeError(k.end, `The indefinite map that starts at ${at(item.off)} has a key with no value before its "break" byte at ${at(k.end)}.`);
        let v;
        try { v = stepMC(fmt, buf, k.end, depth); } catch (e) { if (e.partial) e.partial.keyOff = p; throw e; }
        entries.push({ keyOff: p, keyEnd: k.end, off: k.end, end: v.end });
        p = v.end;
      } else {
        const v = stepMC(fmt, buf, p, depth);
        entries.push({ off: p, end: v.end });
        p = v.end;
      }
    }
    if (item.indef) item.n = entries.length;
    if (item.end < 0) item.end = p;
  } catch (e) { return fail(entries, e); }
  return { entries, err: null, partial: null };
}

/** The values at the top of the file. BSON documents are also checked inside: a damaged one is listed with broken. */
function scanTop(fmtId, buf) {
  if (fmtId === 'bson') {
    const r = bson.scanTop(buf);
    let first = r.err;
    for (const e of r.entries) {
      const bad = check('bson', buf, bson.itemOf(buf, e));
      if (bad) { e.broken = true; if (!first) first = bad; }
    }
    return { entries: r.entries, err: first, partial: r.partial, lengthErr: r.err };
  }
  const fmt = FORMATS[fmtId];
  const entries = [];
  let p = 0;
  try {
    while (p < buf.length) { const s = stepMC(fmt, buf, p, 0); entries.push({ off: p, end: s.end }); p = s.end; }
  } catch (e) { return fail(entries, e); }
  return { entries, err: null, partial: null };
}

/** The first problem inside a container (deep), or null. */
function check(fmtId, buf, item, depth = 0) {
  if (!isContainer(item)) return null;
  if (depth > MAX_DEPTH) { const e = deep(item.off); return { off: e.offset, message: e.message }; }
  const s = scan(fmtId, buf, item, depth);
  if (s.err) return s.err;
  if (fmtId !== 'bson') return null; // MessagePack and CBOR containers were read through by scan
  for (const e of s.entries) { const r = check(fmtId, buf, itemOf(fmtId, buf, e), depth + 1); if (r) return r; }
  return null;
}

/** The item of a scanned entry (or of a partial). */
function itemOf(fmtId, buf, e, broken) {
  if (fmtId === 'bson') return bson.itemOf(buf, e);
  const item = FORMATS[fmtId].head(buf, e.off);
  if (isContainer(item)) {
    if (broken) { item.broken = true; item.end = -1; } else item.end = e.end;
  }
  return item;
}
function keyItemOf(fmtId, buf, e) {
  if (fmtId === 'bson' || e.keyOff === undefined || e.keyOff < 0) return null;
  const k = FORMATS[fmtId].head(buf, e.keyOff);
  if (isContainer(k)) k.end = e.keyEnd;
  return k;
}

// ---------- full decoding into the value model ----------
function toValue(fmtId, buf, item, depth = 0) {
  if (depth > MAX_DEPTH) throw deep(item.off);
  switch (item.kind) {
    case 'map': case 'array': case 'tag': case 'codews': {
      const s = scan(fmtId, buf, item, depth);
      if (s.err) throw new DecodeError(s.err.off, s.err.message);
      if (item.kind === 'tag') return { t: 'tag', tag: item.tag, v: toValue(fmtId, buf, itemOf(fmtId, buf, s.entries[0]), depth + 1) };
      if (item.kind === 'codews') return { t: 'code', v: toValue(fmtId, buf, itemOf(fmtId, buf, s.entries[0]), depth + 1).v, scope: toValue(fmtId, buf, itemOf(fmtId, buf, s.entries[1]), depth + 1) };
      if (item.kind === 'array') return { t: 'arr', v: s.entries.map((e) => toValue(fmtId, buf, itemOf(fmtId, buf, e), depth + 1)) };
      return { t: 'map', v: s.entries.map((e) => [fmtId === 'bson' ? { t: 'str', v: e.name } : toValue(fmtId, buf, keyItemOf(fmtId, buf, e), depth + 1), toValue(fmtId, buf, itemOf(fmtId, buf, e), depth + 1)]) };
    }
    case 'str': return { t: 'str', v: item.v };
    case 'bin': return item.sub !== undefined ? { t: 'bin', v: Buffer.from(item.v), sub: item.sub } : { t: 'bin', v: Buffer.from(item.v) };
    case 'int': return item.w ? { t: 'int', v: item.v, w: item.w } : { t: 'int', v: item.v };
    case 'float': return { t: 'float', v: item.v, w: item.w };
    case 'bool': return { t: 'bool', v: item.v };
    case 'null': return { t: 'null' };
    case 'undefined': return { t: 'undef' };
    case 'ext': return { t: 'ext', type: item.etype, v: Buffer.from(item.v) };
    case 'date': return { t: 'date', s: item.v.s, ns: item.v.ns };
    case 'simple': return { t: 'simple', v: item.v };
    case 'oid': return { t: 'oid', v: Buffer.from(item.v) };
    case 'regex': return { t: 'regex', p: item.v.p, f: item.v.f };
    case 'dbptr': return { t: 'dbptr', ns: item.v.ns, id: Buffer.from(item.v.id) };
    case 'code': return { t: 'code', v: item.v };
    case 'symbol': return { t: 'symbol', v: item.v };
    case 'bts': return { t: 'bts', tm: item.v.t, i: item.v.i };
    case 'dec128': return { t: 'dec128', v: Buffer.from(item.raw) };
    case 'minkey': return { t: 'minkey' };
    case 'maxkey': return { t: 'maxkey' };
    default: throw new DecodeError(item.off, `Cannot read the ${item.label} at ${at(item.off)}.`);
  }
}

/** Every top-level value of a file, decoded. Throws DecodeError at the first problem. */
function decodeAll(fmtId, buf) {
  const top = scanTop(fmtId, buf);
  if (top.err) throw new DecodeError(top.err.off, top.err.message);
  return top.entries.map((e) => toValue(fmtId, buf, itemOf(fmtId, buf, e)));
}

// ---------- writing ----------
/** Bytes of one value (MessagePack, CBOR) or one document (BSON). The value must already be lowered (value.lower). */
function encodeOne(fmtId, v) {
  if (fmtId === 'bson') {
    if (v.t !== 'map') throw new Error(`BSON files hold documents (maps) only; this value is ${v.t === 'arr' ? 'an array' : `a ${v.t}`}.`);
    return bson.docBytes(v, '(root)');
  }
  const o = new Out();
  FORMATS[fmtId].write(o, v, '(root)');
  return o.done();
}
function encodeAll(fmtId, values) { return Buffer.concat(values.map((v) => encodeOne(fmtId, v))); }

/**
 * Writes one edited value back. chain: [{ item, entry }] from a top-level value down to the edited value. MessagePack
 * and CBOR: the value's bytes are replaced (every other byte stays as it was). BSON: the element (type byte, name,
 * value) is replaced and the length of every document around it is corrected. Returns the new file bytes, checked.
 */
function spliceValue(fmtId, buf, chain, v) {
  const last = chain[chain.length - 1];
  const { item, entry } = last;
  if (item.end < 0) throw new Error('This value is inside damaged data and cannot be edited.');
  let start; let end; let bytes;
  if (fmtId === 'bson') {
    if (entry.elemOff === undefined || entry.elemOff < 0) {
      if (entry.name === '$code' && v.t === 'str') { start = item.off; end = item.end; const o = new Out(); const b = Buffer.from(v.v, 'utf8'); o.num('writeInt32LE', 4, b.length + 1); o.bytes(b); o.u8(0); bytes = o.done(); }
      else throw new Error('Only values inside a document can be edited; a whole top-level document cannot.');
    } else {
      const vb = bson.valueBytes(v, entry.name);
      start = entry.elemOff; end = item.end;
      bytes = Buffer.concat([Buffer.from([vb.type]), buf.subarray(entry.keyOff, entry.off), vb.bytes]);
    }
  } else {
    start = item.off; end = item.end;
    bytes = encodeOne(fmtId, v);
  }
  const out = Buffer.concat([buf.subarray(0, start), bytes, buf.subarray(end)]);
  const delta = bytes.length - (end - start);
  if (fmtId === 'bson' && delta) {
    for (const c of chain.slice(0, -1)) {
      if (c.item.kind === 'map' || c.item.kind === 'array' || c.item.kind === 'codews') out.writeInt32LE(out.readInt32LE(c.item.off) + delta, c.item.off);
    }
  }
  const top = scanTop(fmtId, out);
  if (top.err) throw new Error(`The edit was not saved: the result would not read back (${top.err.message}).`);
  return { bytes: out, start, oldLen: end - start, newLen: bytes.length };
}

module.exports = { FORMATS, MAX_DEPTH, isContainer, endOf, scan, scanTop, check, itemOf, keyItemOf, toValue, decodeAll, encodeOne, encodeAll, spliceValue };
