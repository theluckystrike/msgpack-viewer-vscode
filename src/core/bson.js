'use strict';
// BSON reader and writer, written for this extension from the BSON 1.1 specification (bsonspec.org): documents and
// arrays with their int32 lengths and every element type, including ObjectId, UTC datetime, binary subtypes,
// regular expressions, timestamps, decimal128, MinKey and MaxKey, and the deprecated types. A .bson file is one or more
// documents one after another (as a database dump writes them). No third-party code.
const { DecodeError, at, need, utf8 } = require('./common');

const ID = 'bson';
const NAME = 'BSON';
const SUBTYPES = { 0: 'generic', 1: 'function', 2: 'binary (old)', 3: 'UUID (old)', 4: 'UUID', 5: 'MD5', 6: 'encrypted', 7: 'compressed column', 8: 'sensitive', 9: 'vector' };
const TYPES = {
  0x01: 'double', 0x02: 'string', 0x03: 'document', 0x04: 'array', 0x05: 'binary', 0x06: 'undefined (deprecated)', 0x07: 'ObjectId',
  0x08: 'boolean', 0x09: 'UTC datetime', 0x0a: 'null', 0x0b: 'regular expression', 0x0c: 'DBPointer (deprecated)', 0x0d: 'JavaScript code',
  0x0e: 'symbol (deprecated)', 0x0f: 'code with scope (deprecated)', 0x10: 'int32', 0x11: 'timestamp', 0x12: 'int64', 0x13: 'decimal128',
  0xff: 'MinKey', 0x7f: 'MaxKey',
};

/** A document or array at off: checks its length and its last byte. */
function docItem(buf, off, kind = 'map') {
  need(buf, off, 4, `the length of the ${kind === 'array' ? 'array' : 'document'} at ${at(off)}`);
  const len = buf.readInt32LE(off);
  const what = kind === 'array' ? 'array' : 'document';
  if (len < 5) throw new DecodeError(off, `The ${what} at ${at(off)} says it is ${len} bytes long; a BSON ${what} is at least 5 bytes.`);
  if (off + len > buf.length) throw new DecodeError(off, `The file ends early: the ${what} at ${at(off)} says it is ${len.toLocaleString('en-US')} bytes long, but only ${(buf.length - off).toLocaleString('en-US')} bytes are left.`);
  if (buf[off + len - 1] !== 0) throw new DecodeError(off + len - 1, `The ${what} that starts at ${at(off)} should end with a 0 byte at ${at(off + len - 1)}, but that byte is 0x${buf[off + len - 1].toString(16)}.`);
  return { kind, label: what, off, hdr: 4, len, end: off + len, n: -1 };
}

function cstring(buf, p, limit, what) {
  const z = buf.indexOf(0, p);
  if (z < 0 || z >= limit) throw new DecodeError(p, `The ${what} at ${at(p)} has no closing 0 byte inside its document.`);
  const t = utf8(buf.subarray(p, z));
  return { text: t.text, bad: t.bad, end: z + 1 };
}
function bstring(buf, p, limit, what) {
  if (p + 4 > limit) throw new DecodeError(p, `The ${what} at ${at(p)} runs past the end of its document.`);
  const n = buf.readInt32LE(p);
  if (n < 1) throw new DecodeError(p, `The ${what} at ${at(p)} says it is ${n} bytes long; a BSON string is at least 1 byte (its closing 0).`);
  if (p + 4 + n > limit) throw new DecodeError(p, `The ${what} at ${at(p)} says it is ${n.toLocaleString('en-US')} bytes long, which runs past the end of its document.`);
  if (buf[p + 4 + n - 1] !== 0) throw new DecodeError(p + 4 + n - 1, `The ${what} at ${at(p)} should end with a 0 byte at ${at(p + 4 + n - 1)}.`);
  const t = utf8(buf.subarray(p + 4, p + 4 + n - 1));
  return { text: t.text, bad: t.bad, end: p + 4 + n, len: n - 1 };
}

function fixed(buf, p, n, limit, what) {
  if (p + n > limit) throw new DecodeError(p, `The ${what} at ${at(p)} needs ${n} bytes, which runs past the end of its document.`);
}

/** The value of an element of type `type` at off, inside a document that ends at limit (its closing 0 byte). */
function valueAt(buf, type, off, limit) {
  const name = TYPES[type];
  switch (type) {
    case 0x01: fixed(buf, off, 8, limit, 'double'); return { kind: 'float', label: name, w: 64, off, hdr: 0, len: 8, end: off + 8, v: buf.readDoubleLE(off) };
    case 0x02: case 0x0d: case 0x0e: {
      const s = bstring(buf, off, limit, name);
      return { kind: type === 0x02 ? 'str' : type === 0x0d ? 'code' : 'symbol', label: name, off, hdr: 4, len: s.len, end: s.end, v: s.text, bad: s.bad };
    }
    case 0x03: case 0x04: {
      const d = docItem(buf, off, type === 0x04 ? 'array' : 'map');
      if (d.end > limit) throw new DecodeError(off, `The ${d.label} at ${at(off)} says it is ${d.len} bytes long, which runs past the end of its parent document.`);
      return d;
    }
    case 0x05: {
      fixed(buf, off, 5, limit, 'binary');
      const n = buf.readInt32LE(off);
      if (n < 0 || off + 5 + n > limit) throw new DecodeError(off, `The binary at ${at(off)} says it is ${n.toLocaleString('en-US')} bytes long, which runs past the end of its document.`);
      const sub = buf[off + 4];
      if (sub === 2 && (n < 4 || buf.readInt32LE(off + 5) !== n - 4)) throw new DecodeError(off, `The old binary (subtype 2) at ${at(off)} holds an inner length that does not match its size (${n} bytes).`);
      const sn = SUBTYPES[sub] || (sub >= 0x80 ? 'user defined' : 'unknown');
      return { kind: 'bin', label: `binary (subtype ${sub}: ${sn})`, sub, off, hdr: 5, len: n, end: off + 5 + n, v: buf.subarray(off + 5, off + 5 + n) };
    }
    case 0x06: return { kind: 'undefined', label: name, off, hdr: 0, len: 0, end: off, v: undefined };
    case 0x07: fixed(buf, off, 12, limit, 'ObjectId'); return { kind: 'oid', label: name, off, hdr: 0, len: 12, end: off + 12, v: buf.subarray(off, off + 12) };
    case 0x08: {
      fixed(buf, off, 1, limit, 'boolean');
      if (buf[off] > 1) throw new DecodeError(off, `The boolean at ${at(off)} is 0x${buf[off].toString(16)}; BSON allows only 0 or 1.`);
      return { kind: 'bool', label: name, off, hdr: 0, len: 1, end: off + 1, v: buf[off] === 1 };
    }
    case 0x09: {
      fixed(buf, off, 8, limit, 'UTC datetime');
      const ms = buf.readBigInt64LE(off);
      const s = ms >= 0n ? ms / 1000n : -((-ms + 999n) / 1000n);
      return { kind: 'date', label: name, off, hdr: 0, len: 8, end: off + 8, v: { s, ns: Number(ms - s * 1000n) * 1e6 }, ms };
    }
    case 0x0a: return { kind: 'null', label: name, off, hdr: 0, len: 0, end: off, v: null };
    case 0x0b: {
      const p = cstring(buf, off, limit, 'regular expression pattern');
      const f = cstring(buf, p.end, limit, 'regular expression options');
      return { kind: 'regex', label: name, off, hdr: 0, len: f.end - off, end: f.end, v: { p: p.text, f: f.text } };
    }
    case 0x0c: {
      const s = bstring(buf, off, limit, 'DBPointer name');
      fixed(buf, s.end, 12, limit, 'DBPointer id');
      return { kind: 'dbptr', label: name, off, hdr: 0, len: s.end + 12 - off, end: s.end + 12, v: { ns: s.text, id: buf.subarray(s.end, s.end + 12) } };
    }
    case 0x0f: {
      fixed(buf, off, 4, limit, 'code with scope');
      const n = buf.readInt32LE(off);
      if (n < 14 || off + n > limit) throw new DecodeError(off, `The code with scope at ${at(off)} says it is ${n} bytes long, which does not fit its document.`);
      return { kind: 'codews', label: name, off, hdr: 4, len: n, end: off + n, n: 2 };
    }
    case 0x10: fixed(buf, off, 4, limit, 'int32'); return { kind: 'int', label: name, w: 32, off, hdr: 0, len: 4, end: off + 4, v: BigInt(buf.readInt32LE(off)) };
    case 0x11: fixed(buf, off, 8, limit, 'timestamp'); return { kind: 'bts', label: name, off, hdr: 0, len: 8, end: off + 8, v: { i: buf.readUInt32LE(off), t: buf.readUInt32LE(off + 4) } };
    case 0x12: fixed(buf, off, 8, limit, 'int64'); return { kind: 'int', label: name, w: 64, off, hdr: 0, len: 8, end: off + 8, v: buf.readBigInt64LE(off) };
    case 0x13: fixed(buf, off, 16, limit, 'decimal128'); return { kind: 'dec128', label: name, off, hdr: 0, len: 16, end: off + 16, v: decimalText(buf.subarray(off, off + 16)), raw: buf.subarray(off, off + 16) };
    case 0xff: return { kind: 'minkey', label: name, off, hdr: 0, len: 0, end: off, v: null };
    case 0x7f: return { kind: 'maxkey', label: name, off, hdr: 0, len: 0, end: off, v: null };
    default: throw new DecodeError(off - 1, `Unknown BSON element type 0x${type.toString(16).padStart(2, '0')} at ${at(off - 1)}.`);
  }
}

/** Elements of a document or array item, or the two parts of a code with scope. { entries, err, partial }. */
function scan(buf, item) {
  const entries = [];
  if (item.kind === 'codews') {
    try {
      const code = bstring(buf, item.off + 4, item.end, 'code');
      entries.push({ name: '$code', type: 0x02, off: item.off + 4, end: code.end, elemOff: -1 });
      const d = docItem(buf, code.end, 'map');
      if (d.end !== item.end) throw new DecodeError(code.end, `The scope of the code with scope at ${at(item.off)} does not end where the code with scope ends.`);
      entries.push({ name: '$scope', type: 0x03, off: code.end, end: d.end, elemOff: -1 });
      return { entries, err: null, partial: null };
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      return { entries, err: { off: e.offset, message: e.message }, partial: null };
    }
  }
  const limit = item.end - 1;
  let p = item.off + 4;
  try {
    while (p < limit) {
      const type = buf[p];
      if (type === 0) throw new DecodeError(p, `A 0 byte at ${at(p)} ends the ${item.label} that starts at ${at(item.off)} before its stated length (${item.len} bytes).`);
      const nm = cstring(buf, p + 1, limit, 'element name');
      if (!TYPES[type]) throw new DecodeError(p, `Unknown BSON element type 0x${type.toString(16).padStart(2, '0')} at ${at(p)} (element "${nm.text}").`);
      let v;
      try { v = valueAt(buf, type, nm.end, limit); } catch (e) {
        if (e instanceof DecodeError && (type === 0x03 || type === 0x04)) {
          // a nested document that is damaged: keep it as a broken node so its own elements can still be read
          const err = new DecodeError(e.offset, e.message);
          err.partial = { name: nm.text, keyOff: p + 1, elemOff: p, type, off: nm.end };
          throw err;
        }
        throw e;
      }
      entries.push({ name: nm.text, badName: nm.bad, keyOff: p + 1, elemOff: p, type, off: nm.end, end: v.end });
      p = v.end;
    }
    if (p !== limit) throw new DecodeError(limit, `The last element of the ${item.label} at ${at(item.off)} runs past its stated length.`);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return { entries, err: { off: e.offset, message: e.message }, partial: e.partial || null };
  }
  return { entries, err: null, partial: null };
}

/** The top-level documents of a .bson file. */
function scanTop(buf) {
  const entries = [];
  let p = 0;
  try {
    while (p < buf.length) {
      const d = docItem(buf, p, 'map');
      entries.push({ type: 0x03, off: p, end: d.end, elemOff: -1 });
      p = d.end;
    }
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    // a document whose length fits but whose inside is damaged is still listed above; this is a bad length
    return { entries, err: { off: e.offset, message: e.message }, partial: null };
  }
  return { entries, err: null, partial: null };
}

/** The item of a scanned entry (type, off, end). A damaged nested document (partial) keeps end -1. */
function itemOf(buf, e) {
  if (e.type === 0x03 || e.type === 0x04) {
    try { return docItem(buf, e.off, e.type === 0x04 ? 'array' : 'map'); } catch (x) { return { kind: e.type === 0x04 ? 'array' : 'map', label: e.type === 0x04 ? 'array' : 'document', off: e.off, hdr: 4, end: -1, n: -1, broken: true }; }
  }
  return valueAt(buf, e.type, e.off, e.end);
}

// ---------- decimal128 ----------
const MASK49 = (1n << 49n) - 1n;
const MAX_SIG = 10n ** 34n - 1n;
function decimalText(b) {
  const lo = b.readBigUInt64LE(0);
  const hi = b.readBigUInt64LE(8);
  const neg = (hi >> 63n) === 1n;
  const comb = Number((hi >> 58n) & 0x1fn);
  let exp; let sig;
  if (comb >> 3 === 3) {
    if (comb === 0x1e) return neg ? '-Infinity' : 'Infinity';
    if (comb === 0x1f) return 'NaN';
    exp = Number((hi >> 47n) & 0x3fffn) - 6176;
    sig = 0n; // a coefficient this large is out of range: the value is 0
  } else {
    exp = Number((hi >> 49n) & 0x3fffn) - 6176;
    sig = ((hi & MASK49) << 64n) | lo;
    if (sig > MAX_SIG) sig = 0n;
  }
  const digits = sig.toString();
  const adj = exp + digits.length - 1;
  let s;
  if (exp <= 0 && adj >= -6) {
    if (exp === 0) s = digits;
    else {
      const point = digits.length + exp;
      s = point > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : `0.${'0'.repeat(-point)}${digits}`;
    }
  } else {
    s = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    s += `E${adj >= 0 ? '+' : ''}${adj}`;
  }
  return (neg ? '-' : '') + s;
}
/** 16 bytes of a decimal text ("1.5", "-0.001E+3", "NaN", "Infinity"), or null when it is not one. */
function decimalBytes(text) {
  const t = String(text).trim();
  const out = Buffer.alloc(16);
  const put = (hi, lo) => { out.writeBigUInt64LE(lo & 0xffffffffffffffffn, 0); out.writeBigUInt64LE(hi & 0xffffffffffffffffn, 8); return out; };
  if (/^nan$/i.test(t)) return put(0x7cn << 56n, 0n);
  const inf = /^([+-])?inf(inity)?$/i.exec(t);
  if (inf) return put((inf[1] === '-' ? 0xf8n : 0x78n) << 56n, 0n);
  const m = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(t);
  if (!m || (!m[2] && !m[3])) return null;
  const neg = m[1] === '-';
  let digits = (m[2] || '') + (m[3] || '');
  let exp = Number(m[4] || 0) - (m[3] || '').length;
  digits = digits.replace(/^0+(?=\d)/, '');
  while (digits.length > 34 && digits.endsWith('0')) { digits = digits.slice(0, -1); exp += 1; }
  if (digits.length > 34) return null;
  if (exp > 6111) { while (exp > 6111 && digits.length < 34 && digits !== '0') { digits += '0'; exp -= 1; } }
  if (digits === '0' || /^0+$/.test(digits)) { digits = '0'; exp = Math.max(-6176, Math.min(6111, exp)); }
  if (exp > 6111 || exp < -6176) return null;
  const sig = BigInt(digits || '0');
  const hi = ((neg ? 1n : 0n) << 63n) | (BigInt(exp + 6176) << 49n) | (sig >> 64n);
  return put(hi, sig & 0xffffffffffffffffn);
}

// ---------- writer ----------
const { Out } = require('./msgpack');
const I32_MIN = -(2n ** 31n);
const I32_MAX = 2n ** 31n - 1n;

function cstr(o, s, path) {
  const b = Buffer.from(s, 'utf8');
  if (b.includes(0)) throw new Error(`${path}: a BSON name cannot hold a 0 byte.`);
  o.bytes(b); o.u8(0);
}
function bstr(o, s) { const b = Buffer.from(s, 'utf8'); o.num('writeInt32LE', 4, b.length + 1); o.bytes(b); o.u8(0); }

/** Writes a document (map) or array of the shared model; returns its bytes. */
function docBytes(x, path) {
  const o = new Out();
  const pairs = x.t === 'arr' ? x.v.map((v, i) => [{ t: 'str', v: String(i) }, v]) : x.v;
  for (const [k, v] of pairs) {
    if (k.t !== 'str') throw new Error(`${path}: BSON documents have text keys only.`);
    elem(o, k.v, v, `${path}.${k.v}`);
  }
  const body = o.done();
  const head = Buffer.alloc(4);
  head.writeInt32LE(body.length + 5);
  return Buffer.concat([head, body, Buffer.from([0])]);
}

/** Type byte and value bytes of one value (no name). */
function valueBytes(v, path) {
  const o = new Out();
  let type;
  switch (v.t) {
    case 'null': type = 0x0a; break;
    case 'undef': type = 0x06; break;
    case 'bool': type = 0x08; o.u8(v.v ? 1 : 0); break;
    case 'int': {
      const fits32 = v.v >= I32_MIN && v.v <= I32_MAX;
      if ((v.w === 32 || !v.w) && fits32) { type = 0x10; o.num('writeInt32LE', 4, Number(v.v)); } else if (v.v >= -(2n ** 63n) && v.v <= 2n ** 63n - 1n) { type = 0x12; o.num('writeBigInt64LE', 8, v.v); } else throw new Error(`${path}: the integer ${v.v} is too large for BSON (int64 at most).`);
      break;
    }
    case 'float': type = 0x01; o.num('writeDoubleLE', 8, v.v); break;
    case 'str': type = 0x02; bstr(o, v.v); break;
    case 'map': type = 0x03; o.bytes(docBytes(v, path)); break;
    case 'arr': type = 0x04; o.bytes(docBytes(v, path)); break;
    case 'bin': type = 0x05; o.num('writeInt32LE', 4, v.v.length); o.u8(v.sub || 0); o.bytes(v.v); break;
    case 'oid': type = 0x07; o.bytes(v.v); break;
    case 'date': { type = 0x09; const ms = BigInt(v.s) * 1000n + BigInt(Math.floor((v.ns || 0) / 1e6)); o.num('writeBigInt64LE', 8, ms); break; }
    case 'regex': type = 0x0b; cstr(o, v.p, path); cstr(o, v.f, path); break;
    case 'dbptr': type = 0x0c; bstr(o, v.ns); o.bytes(v.id); break;
    case 'code':
      if (v.scope) { type = 0x0f; const c = new Out(); bstr(c, v.v); c.bytes(docBytes(v.scope, `${path}.$scope`)); const body = c.done(); o.num('writeInt32LE', 4, body.length + 4); o.bytes(body); } else { type = 0x0d; bstr(o, v.v); }
      break;
    case 'symbol': type = 0x0e; bstr(o, v.v); break;
    case 'bts': type = 0x11; o.num('writeUInt32LE', 4, v.i); o.num('writeUInt32LE', 4, v.tm); break;
    case 'dec128': type = 0x13; o.bytes(v.v); break;
    case 'minkey': type = 0xff; break;
    case 'maxkey': type = 0x7f; break;
    default: throw new Error(`${path}: BSON has no form for ${v.t}.`);
  }
  return { type, bytes: o.done() };
}
function elem(o, name, v, path) {
  const { type, bytes } = valueBytes(v, path);
  o.u8(type); cstr(o, name, path); o.bytes(bytes);
}

module.exports = { ID, NAME, TYPES, SUBTYPES, docItem, valueAt, scan, scanTop, itemOf, decimalText, decimalBytes, docBytes, valueBytes };
