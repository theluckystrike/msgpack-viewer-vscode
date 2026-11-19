'use strict';
// Writes the three shipped samples with this extension's own writers (made-up data, MIT like the rest of the repo):
//   samples/orders.msgpack  a stream of 3 MessagePack order records (timestamps, binary, ext type 5, an integer-keyed map)
//   samples/sensor.cbor     one CBOR reading (tags 1, 2 and 37, float16, an indefinite array, undefined)
//   samples/users.bson      3 BSON documents as a database dump writes them (ObjectId, datetime, int64, decimal128, UUID binary)
// usage: node scripts/make-samples.js
const fs = require('fs');
const path = require('path');
const W = require('../src/core/walk');
const { decimalBytes } = require('../src/core/bson');

const S = (v) => ({ t: 'str', v });
const I = (v, w) => (w ? { t: 'int', v: BigInt(v), w } : { t: 'int', v: BigInt(v) });
const F = (v, w = 64) => ({ t: 'float', v, w });
const B = (v) => ({ t: 'bool', v });
const N = { t: 'null' };
const A = (...v) => ({ t: 'arr', v });
const M = (...pairs) => ({ t: 'map', v: pairs.map(([k, v]) => [typeof k === 'string' ? S(k) : k, v]) });
const D = (iso) => { const ms = Date.parse(iso); return { t: 'date', s: BigInt(Math.floor(ms / 1000)), ns: (ms % 1000) * 1e6 }; };
const bin = (h, sub) => (sub === undefined ? { t: 'bin', v: Buffer.from(h, 'hex') } : { t: 'bin', v: Buffer.from(h, 'hex'), sub });

const dir = path.join(__dirname, '..', 'samples');
fs.mkdirSync(dir, { recursive: true });

// MessagePack: 3 orders, one value after another
const item = (sku, qty, price) => M(['sku', S(sku)], ['qty', I(qty)], ['price', F(price)]);
const orders = [
  M(['id', I(1042)], ['customer', S('C-2201')], ['status', S('paid')], ['created', D('2026-11-02T09:14:05.250Z')],
    ['items', A(item('MUG-01', 2, 12.5), item('TEA-GRN', 1, 7.25))], ['total', F(32.25)], ['paid', B(true)], ['note', N],
    ['tags', A(S('gift'), S('express'))], ['thumb', bin('89504e470d0a1a0a0000000d49484452')], ['geo', { t: 'ext', type: 5, v: Buffer.from('4049c6a7ef9db22d4002dd2f1a9fbe77', 'hex') }],
    ['counts', M([I(1), S('one')], [I(2), S('two')])]),
  M(['id', I(1043)], ['customer', S('C-0187')], ['status', S('open')], ['created', D('2026-11-03T16:40:00Z')],
    ['items', A(item('CUP-SET', 1, 48))], ['total', F(48)], ['paid', B(false)], ['note', S('Leave at the front desk')],
    ['tags', A()], ['thumb', bin('')], ['retries', I(-3)], ['big', I('18446744073709551000')]),
  M(['id', I(1044)], ['customer', S('C-2201')], ['status', S('shipped')], ['created', D('2026-11-04T08:00:00.123Z')],
    ['items', A(item('MUG-01', 4, 12.5), item('LID-02', 4, 1.75), item('BOX-S', 1, 0.5))], ['total', F(57.5)], ['paid', B(true)], ['note', N],
    ['tags', A(S('repeat'))], ['ratio', F(0.75, 32)]),
];
fs.writeFileSync(path.join(dir, 'orders.msgpack'), W.encodeAll('msgpack', orders));

// CBOR: one reading, written by hand where the writer would pick another form (indefinite array, float16)
const head = W.encodeOne('cbor', M(['device', S('greenhouse-3')], ['uuid', { t: 'tag', tag: 37n, v: bin('6f1c3d2e9a0b4c5d8e7f601122334455') }],
  ['at', { t: 'tag', tag: 1n, v: I(1793006400) }], ['temp', F(21.5, 16)], ['humidity', F(0.62, 32)], ['serial', { t: 'tag', tag: 2n, v: bin('0100000000000000000000') }],
  ['calibrated', { t: 'undef' }], ['raw', bin('0a0b0c0d')]));
// add a 9th entry: "samples": an indefinite array of 4 small integers, then fix the map count (8 -> 9)
const extra = Buffer.concat([W.encodeOne('cbor', S('samples')), Buffer.from([0x9f, 0x01, 0x02, 0x03, 0x18, 0x2a, 0xff])]);
const cbor = Buffer.concat([head, extra]);
if (cbor[0] !== 0xa8) throw new Error('unexpected CBOR map head');
cbor[0] = 0xa9;
fs.writeFileSync(path.join(dir, 'sensor.cbor'), Buffer.concat([Buffer.from([0xd9, 0xd9, 0xf7]), cbor]));

// BSON: 3 user documents
const oid = (h) => ({ t: 'oid', v: Buffer.from(h, 'hex') });
const users = [
  M(['_id', oid('6745a1c2e4b0f13a9c2d7e01')], ['name', S('Ana Lima')], ['email', S('ana@example.com')], ['age', I(34, 32)], ['visits', I('9007199254740993', 64)],
    ['score', F(91.5)], ['balance', { t: 'dec128', v: decimalBytes('1250.75') }], ['joined', D('2025-03-14T10:20:30.400Z')], ['active', B(true)],
    ['roles', A(S('admin'), S('editor'))], ['address', M(['city', S('Porto')], ['zip', S('4000-001')])], ['token', bin('9b1deb4d3b7d4bad9bdd2b0d7b3dcb6d', 4)],
    ['pattern', { t: 'regex', p: '^ana', f: 'i' }], ['lastSync', { t: 'bts', tm: 1763540000, i: 7 }], ['manager', N]),
  M(['_id', oid('6745a1c2e4b0f13a9c2d7e02')], ['name', S('Ben Okafor')], ['email', S('ben@example.com')], ['age', I(41, 32)], ['visits', I(12, 64)],
    ['score', F(78)], ['balance', { t: 'dec128', v: decimalBytes('-20.10') }], ['joined', D('2024-08-01T00:00:00Z')], ['active', B(false)],
    ['roles', A(S('viewer'))], ['address', M(['city', S('Lagos')])], ['manager', oid('6745a1c2e4b0f13a9c2d7e01')]),
  M(['_id', oid('6745a1c2e4b0f13a9c2d7e03')], ['name', S('Chen Wei')], ['email', S('chen@example.com')], ['age', I(29, 32)], ['visits', I(0, 64)],
    ['score', { t: 'float', v: NaN, w: 64 }], ['joined', D('2026-01-05T12:00:00Z')], ['active', B(true)], ['roles', A()], ['first', { t: 'minkey' }]),
];
fs.writeFileSync(path.join(dir, 'users.bson'), W.encodeAll('bson', users));
for (const f of fs.readdirSync(dir)) console.log(f, fs.statSync(path.join(dir, f)).size);
