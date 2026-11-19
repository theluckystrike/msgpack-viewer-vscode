'use strict';
// MessagePack reader and writer, written for this extension from the MessagePack specification (msgpack/msgpack
// spec.md): every format byte, ext types and the timestamp extension (type -1, 32, 64 and 96 bit forms).
// head() reads one value's header at an offset: scalars come back whole, maps and arrays with their count (their
// children are read by walk.js). encode() writes a value of the shared model (value.js) with the smallest encoding.
const { DecodeError, at, need, utf8 } = require('./common');

const ID = 'msgpack';
const NAME = 'MessagePack';

function u(buf, off, n) {
  if (n === 1) return buf[off];
  if (n === 2) return buf.readUInt16BE(off);
  if (n === 4) return buf.readUInt32BE(off);
  return Number(buf.readBigUInt64BE(off));
}

function strItem(buf, off, hdr, len, label) {
  need(buf, off + hdr, len, `the ${label} text at ${at(off)}`);
  const { text, bad } = utf8(buf.subarray(off + hdr, off + hdr + len));
  return { kind: 'str', label, off, hdr, len, end: off + hdr + len, v: text, bad };
}
function binItem(buf, off, hdr, len, label) {
  need(buf, off + hdr, len, `the ${label} data at ${at(off)}`);
  return { kind: 'bin', label, off, hdr, len, end: off + hdr + len, v: buf.subarray(off + hdr, off + hdr + len) };
}

/** The timestamp extension (type -1): { s: BigInt, ns } or null when the data is not one of the three forms. */
function timestampOf(data) {
  if (data.length === 4) return { s: BigInt(data.readUInt32BE(0)), ns: 0 };
  if (data.length === 8) {
    const x = data.readBigUInt64BE(0);
    const ns = Number(x >> 34n);
    return ns > 999999999 ? null : { s: x & 0x3ffffffffn, ns };
  }
  if (data.length === 12) {
    const ns = data.readUInt32BE(0);
    return ns > 999999999 ? null : { s: data.readBigInt64BE(4), ns };
  }
  return null;
}

function extItem(buf, off, hdr, len, label) {
  need(buf, off + hdr, len, `the ${label} data at ${at(off)}`);
  const type = buf.readInt8(off + hdr - 1);
  const data = buf.subarray(off + hdr, off + hdr + len);
  const base = { off, hdr, len, end: off + hdr + len, etype: type, data };
  if (type === -1) {
    const t = timestampOf(data);
    if (t) return { ...base, kind: 'date', label: `timestamp ${len * 8}`, v: t };
  }
  return { ...base, kind: 'ext', label, v: data };
}

/** One value at off. Containers: { kind: 'map' | 'array', n, end: -1 }. Throws DecodeError. */
function head(buf, off) {
  need(buf, off, 1, 'a value');
  const b = buf[off];
  if (b <= 0x7f) return { kind: 'int', label: 'positive fixint', off, hdr: 1, end: off + 1, v: BigInt(b) };
  if (b <= 0x8f) return { kind: 'map', label: 'fixmap', off, hdr: 1, n: b & 0x0f, end: -1 };
  if (b <= 0x9f) return { kind: 'array', label: 'fixarray', off, hdr: 1, n: b & 0x0f, end: -1 };
  if (b <= 0xbf) return strItem(buf, off, 1, b & 0x1f, 'fixstr');
  if (b >= 0xe0) return { kind: 'int', label: 'negative fixint', off, hdr: 1, end: off + 1, v: BigInt(b - 256) };
  const sized = (n, what) => { need(buf, off + 1, n, `the length of the ${what} at ${at(off)}`); return u(buf, off + 1, n); };
  switch (b) {
    case 0xc0: return { kind: 'null', label: 'nil', off, hdr: 1, end: off + 1, v: null };
    case 0xc1: throw new DecodeError(off, `Byte 0xC1 at ${at(off)} is never used in MessagePack, so this is not MessagePack data (or the data before it is damaged).`);
    case 0xc2: return { kind: 'bool', label: 'false', off, hdr: 1, end: off + 1, v: false };
    case 0xc3: return { kind: 'bool', label: 'true', off, hdr: 1, end: off + 1, v: true };
    case 0xc4: return binItem(buf, off, 2, sized(1, 'bin8'), 'bin8');
    case 0xc5: return binItem(buf, off, 3, sized(2, 'bin16'), 'bin16');
    case 0xc6: return binItem(buf, off, 5, sized(4, 'bin32'), 'bin32');
    case 0xc7: { const n = sized(1, 'ext8'); need(buf, off + 2, 1, `the type of the ext8 at ${at(off)}`); return extItem(buf, off, 3, n, 'ext8'); }
    case 0xc8: { const n = sized(2, 'ext16'); need(buf, off + 3, 1, `the type of the ext16 at ${at(off)}`); return extItem(buf, off, 4, n, 'ext16'); }
    case 0xc9: { const n = sized(4, 'ext32'); need(buf, off + 5, 1, `the type of the ext32 at ${at(off)}`); return extItem(buf, off, 6, n, 'ext32'); }
    case 0xca: need(buf, off + 1, 4, `the float32 at ${at(off)}`); return { kind: 'float', label: 'float32', w: 32, off, hdr: 1, len: 4, end: off + 5, v: buf.readFloatBE(off + 1) };
    case 0xcb: need(buf, off + 1, 8, `the float64 at ${at(off)}`); return { kind: 'float', label: 'float64', w: 64, off, hdr: 1, len: 8, end: off + 9, v: buf.readDoubleBE(off + 1) };
    case 0xcc: need(buf, off + 1, 1, `the uint8 at ${at(off)}`); return { kind: 'int', label: 'uint8', off, hdr: 1, len: 1, end: off + 2, v: BigInt(buf[off + 1]) };
    case 0xcd: need(buf, off + 1, 2, `the uint16 at ${at(off)}`); return { kind: 'int', label: 'uint16', off, hdr: 1, len: 2, end: off + 3, v: BigInt(buf.readUInt16BE(off + 1)) };
    case 0xce: need(buf, off + 1, 4, `the uint32 at ${at(off)}`); return { kind: 'int', label: 'uint32', off, hdr: 1, len: 4, end: off + 5, v: BigInt(buf.readUInt32BE(off + 1)) };
    case 0xcf: need(buf, off + 1, 8, `the uint64 at ${at(off)}`); return { kind: 'int', label: 'uint64', off, hdr: 1, len: 8, end: off + 9, v: buf.readBigUInt64BE(off + 1) };
    case 0xd0: need(buf, off + 1, 1, `the int8 at ${at(off)}`); return { kind: 'int', label: 'int8', off, hdr: 1, len: 1, end: off + 2, v: BigInt(buf.readInt8(off + 1)) };
    case 0xd1: need(buf, off + 1, 2, `the int16 at ${at(off)}`); return { kind: 'int', label: 'int16', off, hdr: 1, len: 2, end: off + 3, v: BigInt(buf.readInt16BE(off + 1)) };
    case 0xd2: need(buf, off + 1, 4, `the int32 at ${at(off)}`); return { kind: 'int', label: 'int32', off, hdr: 1, len: 4, end: off + 5, v: BigInt(buf.readInt32BE(off + 1)) };
    case 0xd3: need(buf, off + 1, 8, `the int64 at ${at(off)}`); return { kind: 'int', label: 'int64', off, hdr: 1, len: 8, end: off + 9, v: buf.readBigInt64BE(off + 1) };
    case 0xd4: need(buf, off + 1, 1, `the type of the fixext1 at ${at(off)}`); return extItem(buf, off, 2, 1, 'fixext1');
    case 0xd5: need(buf, off + 1, 1, `the type of the fixext2 at ${at(off)}`); return extItem(buf, off, 2, 2, 'fixext2');
    case 0xd6: need(buf, off + 1, 1, `the type of the fixext4 at ${at(off)}`); return extItem(buf, off, 2, 4, 'fixext4');
    case 0xd7: need(buf, off + 1, 1, `the type of the fixext8 at ${at(off)}`); return extItem(buf, off, 2, 8, 'fixext8');
    case 0xd8: need(buf, off + 1, 1, `the type of the fixext16 at ${at(off)}`); return extItem(buf, off, 2, 16, 'fixext16');
    case 0xd9: return strItem(buf, off, 2, sized(1, 'str8'), 'str8');
    case 0xda: return strItem(buf, off, 3, sized(2, 'str16'), 'str16');
    case 0xdb: return strItem(buf, off, 5, sized(4, 'str32'), 'str32');
    case 0xdc: return { kind: 'array', label: 'array16', off, hdr: 3, n: sized(2, 'array16'), end: -1 };
    case 0xdd: return { kind: 'array', label: 'array32', off, hdr: 5, n: sized(4, 'array32'), end: -1 };
    case 0xde: return { kind: 'map', label: 'map16', off, hdr: 3, n: sized(2, 'map16'), end: -1 };
    case 0xdf: return { kind: 'map', label: 'map32', off, hdr: 5, n: sized(4, 'map32'), end: -1 };
    default: throw new DecodeError(off, `Unknown MessagePack type byte 0x${b.toString(16)} at ${at(off)}.`);
  }
}

// ---------- writer ----------
class Out {
  constructor() { this.parts = []; this.n = 0; }
  bytes(b) { this.parts.push(Buffer.from(b)); this.n += b.length; }
  u8(...x) { this.bytes(Buffer.from(x)); }
  num(fn, size, v) { const b = Buffer.alloc(size); b[fn](v, 0); this.bytes(b); }
  done() { return Buffer.concat(this.parts, this.n); }
}

function writeInt(o, v, path) {
  if (v >= 0n) {
    if (v <= 0x7fn) o.u8(Number(v));
    else if (v <= 0xffn) o.u8(0xcc, Number(v));
    else if (v <= 0xffffn) { o.u8(0xcd); o.num('writeUInt16BE', 2, Number(v)); }
    else if (v <= 0xffffffffn) { o.u8(0xce); o.num('writeUInt32BE', 4, Number(v)); }
    else if (v <= 0xffffffffffffffffn) { o.u8(0xcf); o.num('writeBigUInt64BE', 8, v); }
    else throw new Error(`${path}: the integer ${v} is too large for MessagePack (64 bits at most).`);
  } else if (v >= -32n) o.u8(Number(v) + 256);
  else if (v >= -128n) { o.u8(0xd0); o.num('writeInt8', 1, Number(v)); }
  else if (v >= -32768n) { o.u8(0xd1); o.num('writeInt16BE', 2, Number(v)); }
  else if (v >= -2147483648n) { o.u8(0xd2); o.num('writeInt32BE', 4, Number(v)); }
  else if (v >= -(2n ** 63n)) { o.u8(0xd3); o.num('writeBigInt64BE', 8, v); }
  else throw new Error(`${path}: the integer ${v} is too small for MessagePack (64 bits at most).`);
}
function writeLen(o, n, small, smallMax, c8, c16, c32) {
  if (small !== null && n <= smallMax) o.u8(small | n);
  else if (c8 !== null && n <= 0xff) o.u8(c8, n);
  else if (n <= 0xffff) { o.u8(c16); o.num('writeUInt16BE', 2, n); }
  else { o.u8(c32); o.num('writeUInt32BE', 4, n); }
}
function writeExt(o, type, data) {
  const n = data.length;
  const fix = { 1: 0xd4, 2: 0xd5, 4: 0xd6, 8: 0xd7, 16: 0xd8 }[n];
  if (fix) o.u8(fix);
  else if (n <= 0xff) o.u8(0xc7, n);
  else if (n <= 0xffff) { o.u8(0xc8); o.num('writeUInt16BE', 2, n); }
  else { o.u8(0xc9); o.num('writeUInt32BE', 4, n); }
  o.num('writeInt8', 1, type);
  o.bytes(data);
}
function timestampBytes(s, ns) {
  if (ns === 0 && s >= 0n && s <= 0xffffffffn) { const b = Buffer.alloc(4); b.writeUInt32BE(Number(s)); return b; }
  if (s >= 0n && s < 2n ** 34n) { const b = Buffer.alloc(8); b.writeBigUInt64BE((BigInt(ns) << 34n) | s); return b; }
  const b = Buffer.alloc(12); b.writeUInt32BE(ns, 0); b.writeBigInt64BE(BigInt(s), 4); return b;
}

/** Bytes of a value of the shared model (value.js). Types MessagePack has no form for are lowered first (value.lower). */
function write(o, x, path) {
  switch (x.t) {
    case 'null': case 'undef': o.u8(0xc0); return;
    case 'bool': o.u8(x.v ? 0xc3 : 0xc2); return;
    case 'int': writeInt(o, x.v, path); return;
    case 'float':
      if (x.w === 32 || x.w === 16) { o.u8(0xca); o.num('writeFloatBE', 4, x.v); } else { o.u8(0xcb); o.num('writeDoubleBE', 8, x.v); }
      return;
    case 'str': { const b = Buffer.from(x.v, 'utf8'); writeLen(o, b.length, 0xa0, 31, 0xd9, 0xda, 0xdb); o.bytes(b); return; }
    case 'bin': writeLen(o, x.v.length, null, 0, 0xc4, 0xc5, 0xc6); o.bytes(x.v); return;
    case 'arr': writeLen(o, x.v.length, 0x90, 15, null, 0xdc, 0xdd); x.v.forEach((c, i) => write(o, c, `${path}[${i}]`)); return;
    case 'map': writeLen(o, x.v.length, 0x80, 15, null, 0xde, 0xdf); for (const [k, v] of x.v) { write(o, k, `${path} key`); write(o, v, `${path}.${k.t === 'str' ? k.v : '?'}`); } return;
    case 'ext': writeExt(o, x.type, x.v); return;
    case 'date': writeExt(o, -1, timestampBytes(BigInt(x.s), x.ns || 0)); return;
    default: throw new Error(`${path}: MessagePack has no form for ${x.t}.`);
  }
}

module.exports = { ID, NAME, head, write, Out, timestampOf, timestampBytes };
