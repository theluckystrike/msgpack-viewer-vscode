'use strict';
// Shared helpers of the three readers (MessagePack, CBOR, BSON): the error with a byte offset, UTF-8 text, hex,
// dates and number text. No vscode import, so the unit tests load it directly.

class DecodeError extends Error {
  /** offset: the byte where the problem is (0-based). */
  constructor(offset, message) {
    super(message);
    this.offset = offset;
  }
}

const at = (n) => `byte ${Number(n).toLocaleString('en-US')} (0x${Number(n).toString(16).toUpperCase()})`;
const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${Number(n) === 1 ? one : many}`;

/** Throws when [off, off + len) is not inside buf. what: "a str8 at byte 12" style text. */
function need(buf, off, len, what) {
  if (off + len > buf.length) {
    const left = Math.max(0, buf.length - off);
    throw new DecodeError(Math.min(off, buf.length), `The file ends early: ${what} needs ${plural(len, 'byte', 'bytes')} at ${at(off)}, but only ${left.toLocaleString('en-US')} ${left === 1 ? 'byte is' : 'bytes are'} left.`);
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const UTF8_LOOSE = new TextDecoder('utf-8');
/** { text, bad } of UTF-8 bytes; bad = the bytes are not valid UTF-8 (text then has replacement characters). */
function utf8(bytes) {
  try { return { text: UTF8.decode(bytes), bad: false }; } catch (e) { return { text: UTF8_LOOSE.decode(bytes), bad: true }; }
}

function hex(bytes, max = Infinity, sep = ' ') {
  const n = Math.min(bytes.length, max);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = bytes[i].toString(16).padStart(2, '0');
  return out.join(sep);
}

function fromHex(text) {
  const s = String(text).replace(/^0x/i, '').replace(/[\s:,-]+/g, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) return null;
  return Buffer.from(s, 'hex');
}

/** Seconds (BigInt) and nanoseconds since 1970 as an ISO 8601 UTC text with only the fraction digits needed. */
function isoOf(sec, ns = 0) {
  const s = BigInt(sec);
  const ms = s * 1000n + BigInt(Math.floor(ns / 1e6));
  if (ms > 8640000000000000n || ms < -8640000000000000n) return '';
  const d = new Date(Number(ms));
  const base = d.toISOString().slice(0, 19);
  let frac = '';
  if (ns) {
    frac = String(ns).padStart(9, '0');
    if (frac.endsWith('000000')) frac = frac.slice(0, 3);
    else if (frac.endsWith('000')) frac = frac.slice(0, 6);
    frac = `.${frac}`;
  }
  return `${base}${frac}Z`;
}

/** { s: BigInt seconds, ns } of an ISO 8601 date text (any time zone offset, up to 9 fraction digits), or null. */
function parseIso(text) {
  const m = /^\s*([+-]?\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?\s*$/.exec(String(text));
  if (!m) return null;
  const [, y, mo, da, h = '0', mi = '0', se = '0', fr = '', tz = 'Z'] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(se));
  if (!Number.isFinite(ms) || Number(mo) < 1 || Number(mo) > 12 || Number(da) < 1 || Number(da) > 31 || Number(h) > 23 || Number(mi) > 59 || Number(se) > 60) return null;
  let off = 0;
  if (!/^z$/i.test(tz)) { const t = /^([+-])(\d{2}):?(\d{2})$/.exec(tz); off = (t[1] === '-' ? -1 : 1) * (Number(t[2]) * 60 + Number(t[3])) * 60; }
  const ns = Number(fr.padEnd(9, '0') || 0);
  return { s: BigInt(Math.floor(ms / 1000)) - BigInt(off), ns };
}

/** Shortest text of a float that reads back the same; always has a dot or an exponent ("1.0", "1e+21"). */
function floatText(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (Object.is(x, -0)) return '-0.0';
  const s = String(x);
  return /[.eE]/.test(s) ? s : `${s}.0`;
}

/** Number of a float32 (rounded like a C float). */
const F32 = new Float32Array(1);
function toF32(x) { F32[0] = x; return F32[0]; }

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}
/** The half-precision bits of x when x fits exactly, else -1. */
function floatToHalf(x) {
  if (Number.isNaN(x)) return 0x7e00;
  if (x === Infinity) return 0x7c00;
  if (x === -Infinity) return 0xfc00;
  if (x === 0) return Object.is(x, -0) ? 0x8000 : 0;
  const sign = x < 0 ? 0x8000 : 0;
  const a = Math.abs(x);
  let e = Math.floor(Math.log2(a));
  if (e < -14) { const f = a / 2 ** -24; return Number.isInteger(f) && f < 1024 ? sign | f : -1; }
  if (e > 15) return -1;
  let f = (a / 2 ** e - 1) * 1024;
  if (f >= 1024) { e += 1; f = 0; }
  if (!Number.isInteger(f) || e > 15) return -1;
  return sign | ((e + 15) << 10) | f;
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

function sizeText(n) {
  if (n < 1024) return plural(n, 'byte', 'bytes');
  const u = ['KB', 'MB', 'GB'];
  let v = n; let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

module.exports = { DecodeError, at, plural, need, utf8, hex, fromHex, isoOf, parseIso, floatText, toF32, halfToFloat, floatToHalf, INT64_MIN, INT64_MAX, UINT64_MAX, sizeText };
