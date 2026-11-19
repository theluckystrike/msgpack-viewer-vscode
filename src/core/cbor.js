'use strict';
// CBOR reader and writer, written for this extension from RFC 8949: the eight major types, definite and indefinite
// lengths, tags, simple values and half, single and double floats. A file can hold one data item or a CBOR sequence
// (RFC 8742: items one after another). head() reads one item's header; arrays, maps and tags come back as
// containers whose children walk.js reads. encode() writes the shared value model (value.js) in preferred form.
const { DecodeError, at, need, utf8, halfToFloat, floatToHalf, toF32 } = require('./common');

const ID = 'cbor';
const NAME = 'CBOR';
const MAJOR = ['unsigned integer', 'negative integer', 'byte string', 'text string', 'array', 'map', 'tag', 'simple or float'];

const TAGS = {
  0: 'date/time text', 1: 'epoch date/time', 2: 'unsigned bignum', 3: 'negative bignum', 4: 'decimal fraction', 5: 'bigfloat',
  21: 'expected base64url', 22: 'expected base64', 23: 'expected base16', 24: 'encoded CBOR item', 32: 'URI', 33: 'base64url text',
  34: 'base64 text', 35: 'regular expression', 36: 'MIME message', 37: 'UUID', 55799: 'self-described CBOR',
};
function tagName(n) {
  const k = Number(n);
  if (TAGS[k]) return TAGS[k];
  if (k >= 64 && k <= 87) return 'typed array';
  return '';
}

/** { arg, hdr } of the header at off; arg is a Number (or BigInt above 2^53), -1 for indefinite. */
function argOf(buf, off) {
  const ai = buf[off] & 31;
  if (ai < 24) return { arg: ai, hdr: 1 };
  if (ai === 24) { need(buf, off + 1, 1, `the 1-byte argument at ${at(off)}`); return { arg: buf[off + 1], hdr: 2 }; }
  if (ai === 25) { need(buf, off + 1, 2, `the 2-byte argument at ${at(off)}`); return { arg: buf.readUInt16BE(off + 1), hdr: 3 }; }
  if (ai === 26) { need(buf, off + 1, 4, `the 4-byte argument at ${at(off)}`); return { arg: buf.readUInt32BE(off + 1), hdr: 5 }; }
  if (ai === 27) {
    need(buf, off + 1, 8, `the 8-byte argument at ${at(off)}`);
    const v = buf.readBigUInt64BE(off + 1);
    return { arg: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v, hdr: 9 };
  }
  if (ai === 31) return { arg: -1, hdr: 1 };
  throw new DecodeError(off, `Byte 0x${buf[off].toString(16)} at ${at(off)} uses the reserved additional value ${ai}: this is not valid CBOR.`);
}

function lenOf(arg, off, what) {
  if (typeof arg === 'bigint' || arg > 0xffffffff * 64) throw new DecodeError(off, `The ${what} at ${at(off)} says it is ${arg} long, more than any file can hold.`);
  return arg;
}

/** Definite or indefinite byte or text string: { v: Buffer, end, chunks }. */
function stringBytes(buf, off, mt, arg, hdr, what) {
  if (arg >= 0) {
    const n = lenOf(arg, off, what);
    need(buf, off + hdr, n, `the ${what} at ${at(off)}`);
    return { v: buf.subarray(off + hdr, off + hdr + n), end: off + hdr + n, chunks: 0 };
  }
  const parts = [];
  let p = off + 1;
  for (;;) {
    need(buf, p, 1, `the next chunk of the indefinite ${what} that starts at ${at(off)}`);
    if (buf[p] === 0xff) { p++; break; }
    if (buf[p] >> 5 !== mt) throw new DecodeError(p, `A chunk of the indefinite ${what} that starts at ${at(off)} must be a ${what} too; ${at(p)} holds a ${MAJOR[buf[p] >> 5]}.`);
    const a = argOf(buf, p);
    if (a.arg < 0) throw new DecodeError(p, `A chunk of the indefinite ${what} that starts at ${at(off)} cannot be indefinite itself (${at(p)}).`);
    const n = lenOf(a.arg, p, what);
    need(buf, p + a.hdr, n, `the chunk at ${at(p)}`);
    parts.push(buf.subarray(p + a.hdr, p + a.hdr + n));
    p += a.hdr + n;
  }
  return { v: Buffer.concat(parts), end: p, chunks: parts.length };
}

/** One data item at off. Arrays, maps and tags: containers with end -1 (n -1 while an indefinite length is unknown). */
function head(buf, off) {
  need(buf, off, 1, 'a data item');
  const ib = buf[off];
  const mt = ib >> 5;
  const ai = ib & 31;
  if (mt === 7) {
    if (ai < 20) return { kind: 'simple', label: `simple(${ai})`, off, hdr: 1, end: off + 1, v: ai };
    if (ai === 20 || ai === 21) return { kind: 'bool', label: ai === 21 ? 'true' : 'false', off, hdr: 1, end: off + 1, v: ai === 21 };
    if (ai === 22) return { kind: 'null', label: 'null', off, hdr: 1, end: off + 1, v: null };
    if (ai === 23) return { kind: 'undefined', label: 'undefined', off, hdr: 1, end: off + 1, v: undefined };
    if (ai === 24) {
      need(buf, off + 1, 1, `the simple value at ${at(off)}`);
      const v = buf[off + 1];
      // RFC 8949 wants values below 32 in the one-byte form; RFC 7049 allowed them here, so they are read as they are
      return { kind: 'simple', label: `simple(${v})`, off, hdr: 1, len: 1, end: off + 2, v, odd: v < 32 };
    }
    if (ai === 25) { need(buf, off + 1, 2, `the float16 at ${at(off)}`); return { kind: 'float', label: 'float16', w: 16, off, hdr: 1, len: 2, end: off + 3, v: halfToFloat(buf.readUInt16BE(off + 1)) }; }
    if (ai === 26) { need(buf, off + 1, 4, `the float32 at ${at(off)}`); return { kind: 'float', label: 'float32', w: 32, off, hdr: 1, len: 4, end: off + 5, v: buf.readFloatBE(off + 1) }; }
    if (ai === 27) { need(buf, off + 1, 8, `the float64 at ${at(off)}`); return { kind: 'float', label: 'float64', w: 64, off, hdr: 1, len: 8, end: off + 9, v: buf.readDoubleBE(off + 1) }; }
    if (ai === 31) throw new DecodeError(off, `A "break" byte (0xFF) at ${at(off)} where no indefinite-length item is open.`);
    throw new DecodeError(off, `Byte 0x${ib.toString(16)} at ${at(off)} uses the reserved additional value ${ai}: this is not valid CBOR.`);
  }
  const { arg, hdr } = argOf(buf, off);
  if (arg === -1 && (mt === 0 || mt === 1 || mt === 6)) throw new DecodeError(off, `Byte 0x${ib.toString(16)} at ${at(off)}: a ${MAJOR[mt]} cannot have an indefinite length.`);
  switch (mt) {
    case 0: return { kind: 'int', label: 'unsigned', off, hdr: 1, len: hdr - 1, end: off + hdr, v: BigInt(arg) };
    case 1: return { kind: 'int', label: 'negative', off, hdr: 1, len: hdr - 1, end: off + hdr, v: -1n - BigInt(arg) };
    case 2: {
      const s = stringBytes(buf, off, 2, arg, hdr, 'byte string');
      return { kind: 'bin', label: arg < 0 ? 'bytes (indefinite)' : 'bytes', off, hdr: arg < 0 ? 1 : hdr, len: s.v.length, end: s.end, v: s.v, chunks: s.chunks };
    }
    case 3: {
      const s = stringBytes(buf, off, 3, arg, hdr, 'text string');
      const t = utf8(s.v);
      return { kind: 'str', label: arg < 0 ? 'text (indefinite)' : 'text', off, hdr: arg < 0 ? 1 : hdr, len: s.v.length, end: s.end, v: t.text, bad: t.bad, chunks: s.chunks };
    }
    case 4: return { kind: 'array', label: arg < 0 ? 'array (indefinite)' : 'array', off, hdr, n: arg < 0 ? -1 : lenOf(arg, off, 'array'), indef: arg < 0, end: -1 };
    case 5: return { kind: 'map', label: arg < 0 ? 'map (indefinite)' : 'map', off, hdr, n: arg < 0 ? -1 : lenOf(arg, off, 'map'), indef: arg < 0, end: -1 };
    default: return { kind: 'tag', label: `tag ${arg}`, tag: BigInt(arg), tagName: tagName(arg), off, hdr, n: 1, end: -1 };
  }
}

// ---------- writer ----------
const { Out } = require('./msgpack');

function writeHead(o, mt, n) {
  const v = BigInt(n);
  if (v < 24n) o.u8((mt << 5) | Number(v));
  else if (v <= 0xffn) o.u8((mt << 5) | 24, Number(v));
  else if (v <= 0xffffn) { o.u8((mt << 5) | 25); o.num('writeUInt16BE', 2, Number(v)); }
  else if (v <= 0xffffffffn) { o.u8((mt << 5) | 26); o.num('writeUInt32BE', 4, Number(v)); }
  else { o.u8((mt << 5) | 27); o.num('writeBigUInt64BE', 8, v); }
}
function bigBytes(v) {
  let h = v.toString(16);
  if (h.length % 2) h = `0${h}`;
  return Buffer.from(h, 'hex');
}

function write(o, x, path) {
  switch (x.t) {
    case 'null': o.u8(0xf6); return;
    case 'undef': o.u8(0xf7); return;
    case 'bool': o.u8(x.v ? 0xf5 : 0xf4); return;
    case 'int': {
      const v = x.v;
      if (v >= 0n) { if (v <= 0xffffffffffffffffn) writeHead(o, 0, v); else { writeHead(o, 6, 2); const b = bigBytes(v); writeHead(o, 2, b.length); o.bytes(b); } }
      else { const m = -1n - v; if (m <= 0xffffffffffffffffn) writeHead(o, 1, m); else { writeHead(o, 6, 3); const b = bigBytes(m); writeHead(o, 2, b.length); o.bytes(b); } }
      return;
    }
    case 'float': {
      if (x.w === 16) { const h = floatToHalf(x.v); if (h >= 0) { o.u8(0xf9); o.num('writeUInt16BE', 2, h); return; } }
      if (x.w === 16 || x.w === 32) { if (Number.isNaN(x.v) || toF32(x.v) === x.v) { o.u8(0xfa); o.num('writeFloatBE', 4, x.v); return; } }
      o.u8(0xfb); o.num('writeDoubleBE', 8, x.v);
      return;
    }
    case 'str': { const b = Buffer.from(x.v, 'utf8'); writeHead(o, 3, b.length); o.bytes(b); return; }
    case 'bin': writeHead(o, 2, x.v.length); o.bytes(x.v); return;
    case 'arr': writeHead(o, 4, x.v.length); x.v.forEach((c, i) => write(o, c, `${path}[${i}]`)); return;
    case 'map': writeHead(o, 5, x.v.length); for (const [k, v] of x.v) { write(o, k, `${path} key`); write(o, v, `${path}.${k.t === 'str' ? k.v : '?'}`); } return;
    case 'tag': writeHead(o, 6, x.tag); write(o, x.v, path); return;
    case 'simple': if (x.v < 24) o.u8(0xe0 | x.v); else o.u8(0xf8, x.v); return;
    case 'date': {
      writeHead(o, 6, 1);
      if (!x.ns) write(o, { t: 'int', v: BigInt(x.s) }, path); else write(o, { t: 'float', v: Number(x.s) + x.ns / 1e9, w: 64 }, path);
      return;
    }
    default: throw new Error(`${path}: CBOR has no form for ${x.t}.`);
  }
}

module.exports = { ID, NAME, head, write, tagName, TAGS };
