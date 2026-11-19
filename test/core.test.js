'use strict';
// The readers and writers without VS Code: MessagePack, CBOR (RFC 8949 Appendix A examples) and BSON, errors with byte
// offsets, the value model and its plain and typed JSON, the comparison, the one-value splice, and the viewer session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const C = require('../src/core/common');
const W = require('../src/core/walk');
const V = require('../src/core/value');
const bson = require('../src/core/bson');
const { Session, parseEdit, editText, textHint, fmtOfName } = require('../src/core/view');

const SAMPLES = path.join(__dirname, '..', 'samples');
const hx = (h) => Buffer.from(h.replace(/\s+/g, ''), 'hex');
const one = (fmt, h) => { const v = W.decodeAll(fmt, hx(h)); assert.equal(v.length, 1); return v[0]; };
const plain = (x) => V.toJson(x, { indent: 0 }).text;
const typed = (x) => V.toJson(x, { mode: 'typed', indent: 0 }).text;
const errOf = (fmt, h) => { const t = W.scanTop(fmt, hx(h)); return t.err; };

// ---------- MessagePack ----------
test('msgpack: every integer form reads with its value and label', () => {
  const cases = [['00', 0n, 'positive fixint'], ['7f', 127n, 'positive fixint'], ['e0', -32n, 'negative fixint'], ['ff', -1n, 'negative fixint'], ['ccff', 255n, 'uint8'], ['cd0100', 256n, 'uint16'],
    ['ce00010000', 65536n, 'uint32'], ['cfffffffffffffffff', 18446744073709551615n, 'uint64'], ['d080', -128n, 'int8'], ['d18000', -32768n, 'int16'], ['d280000000', -2147483648n, 'int32'], ['d38000000000000000', -9223372036854775808n, 'int64']];
  for (const [h, v, label] of cases) {
    const s = new Session(hx(h), 'msgpack');
    const r = s.children(0).rows[0];
    assert.equal(r.type, label, h);
    assert.equal(one('msgpack', h).v, v, h);
  }
});
test('msgpack: floats, strings, binary, nil, booleans, arrays and maps', () => {
  assert.equal(one('msgpack', 'ca3fc00000').v, 1.5);
  assert.equal(one('msgpack', 'cb3ff8000000000000').v, 1.5);
  assert.equal(one('msgpack', 'a3616263').v, 'abc');
  assert.equal(one('msgpack', 'd903616263').v, 'abc');
  assert.equal(one('msgpack', 'da0003616263').v, 'abc');
  assert.equal(one('msgpack', 'db00000003616263').v, 'abc');
  assert.equal(one('msgpack', 'c403010203').v.toString('hex'), '010203');
  assert.equal(one('msgpack', 'c50003010203').v.toString('hex'), '010203');
  assert.equal(one('msgpack', 'c60000000301 0203').v.toString('hex'), '010203');
  assert.equal(one('msgpack', 'c0').t, 'null');
  assert.equal(one('msgpack', 'c3').v, true);
  assert.equal(plain(one('msgpack', '93 01 a161 c2')), '[1,"a",false]');
  assert.equal(plain(one('msgpack', 'dc0002 01 02')), '[1,2]');
  assert.equal(plain(one('msgpack', 'dd00000001 07')), '[7]');
  assert.equal(plain(one('msgpack', '82 a161 01 a162 92 02 03')), '{"a":1,"b":[2,3]}');
  assert.equal(plain(one('msgpack', 'de0001 a161 c0')), '{"a":null}');
  assert.equal(plain(one('msgpack', 'df00000001 01 a3 6f6e65')), '{"1":"one"}');
});
test('msgpack: ext types and the three timestamp forms', () => {
  const e = one('msgpack', 'd505 0102');
  assert.deepEqual([e.t, e.type, e.v.toString('hex')], ['ext', 5, '0102']);
  assert.equal(one('msgpack', 'c703 0b 010203').type, 11);
  assert.equal(one('msgpack', 'c8000209 0102').type, 9);
  assert.equal(one('msgpack', 'c900000001f6 ff').type, -10);
  const t32 = one('msgpack', 'd6ff 5f5e1000');
  assert.deepEqual([t32.t, t32.s, t32.ns], ['date', 1600000000n, 0]);
  const t64 = one('msgpack', W.encodeOne('msgpack', { t: 'date', s: 1600000000n, ns: 500000000 }).toString('hex'));
  assert.equal(C.isoOf(t64.s, t64.ns), '2020-09-13T12:26:40.500Z');
  const t96 = one('msgpack', W.encodeOne('msgpack', { t: 'date', s: -1n, ns: 1 }).toString('hex'));
  assert.deepEqual([t96.s, t96.ns], [-1n, 1]);
  assert.equal(W.encodeOne('msgpack', { t: 'date', s: -1n, ns: 1 })[0], 0xc7);
  const s = new Session(hx('d6ff5f5e1000'), 'msgpack');
  assert.deepEqual([s.children(0).rows[0].type, s.children(0).rows[0].preview], ['timestamp 32', '2020-09-13T12:26:40Z']);
});
test('msgpack: the writer picks the smallest form', () => {
  const enc = (v) => W.encodeOne('msgpack', v).toString('hex');
  assert.equal(enc({ t: 'int', v: 5n }), '05');
  assert.equal(enc({ t: 'int', v: -33n }), 'd0df');
  assert.equal(enc({ t: 'int', v: 65535n }), 'cdffff');
  assert.equal(enc({ t: 'int', v: 4294967296n }), 'cf0000000100000000');
  assert.equal(enc({ t: 'str', v: 'x'.repeat(32) }).slice(0, 4), 'd920');
  assert.equal(enc({ t: 'arr', v: Array(16).fill({ t: 'null' }) }).slice(0, 6), 'dc0010');
  assert.equal(enc({ t: 'float', v: 1.5, w: 32 }), 'ca3fc00000');
  assert.equal(enc({ t: 'ext', type: 1, v: Buffer.alloc(3) }), 'c70301000000');
  assert.throws(() => enc({ t: 'int', v: 2n ** 64n }), /too large for MessagePack/);
});
test('msgpack: bad data gives the byte offset (0xC1, cut short, a count larger than the file)', () => {
  let e = errOf('msgpack', '82 a161 01 a162 c1');
  assert.equal(e.off, 6);
  assert.match(e.message, /0xC1 at byte 6 \(0x6\)/);
  e = errOf('msgpack', 'a5 6162');
  assert.match(e.message, /ends early.*fixstr.*needs 5 bytes at byte 1/);
  e = errOf('msgpack', 'dd ffffffff 01');
  assert.match(e.message, /array32 at byte 0 \(0x0\) says it holds 4,294,967,295 items, but only 1 byte is left/);
  const s = new Session(hx('01 02 93 01'), 'msgpack');
  const top = s.children(0);
  assert.deepEqual(top.rows.map((r) => [r.key, r.broken]), [['#1', false], ['#2', false], ['#3', true]]);
  assert.match(top.err.message, /fixarray at byte 2 \(0x2\) says it holds 3 items, but only 1 byte is left/);
  const inner = s.children(top.rows[2].id);
  assert.equal(inner.rows.length, 1);
  assert.equal(inner.err.off, 4);
  assert.match(inner.err.message, /ends early/);
});
test('msgpack: a stream of values, and our orders sample reads back byte for byte through typed JSON', () => {
  const b = fs.readFileSync(path.join(SAMPLES, 'orders.msgpack'));
  const vals = W.decodeAll('msgpack', b);
  assert.equal(vals.length, 3);
  const t = typed({ t: 'arr', v: vals });
  const back = V.fromJsonText(t)[0].v;
  assert.ok(W.encodeAll('msgpack', back).equals(b));
  assert.match(t, /"counts":\{"\$map":\[\[1,"one"\],\[2,"two"\]\]\}/);
  assert.match(t, /"created":\{"\$date":"2026-11-02T09:14:05.250Z"\}/);
  assert.match(t, /"ratio":\{"\$float32":0.75\}/);
});

// ---------- CBOR (RFC 8949 Appendix A) ----------
const APPX = [
  ['00', '0'], ['17', '23'], ['1818', '24'], ['1903e8', '1000'], ['1a000f4240', '1000000'], ['1b000000e8d4a51000', '1000000000000'],
  ['1bffffffffffffffff', '18446744073709551615'], ['c249010000000000000000', '18446744073709551616'], ['3bffffffffffffffff', '-18446744073709551616'],
  ['c349010000000000000000', '-18446744073709551617'], ['20', '-1'], ['3863', '-100'], ['3903e7', '-1000'],
  ['f90000', '0'], ['f98000', '-0'], ['f93c00', '1'], ['fb3ff199999999999a', '1.1'], ['f93e00', '1.5'], ['f97bff', '65504'], ['fa47c35000', '100000'],
  ['fa7f7fffff', '3.4028234663852886e+38'], ['fb7e37e43c8800759c', '1e+300'], ['f90001', '5.960464477539063e-8'], ['f90400', '0.00006103515625'],
  ['f9c400', '-4'], ['fbc010666666666666', '-4.1'], ['f97c00', '"Infinity"'], ['f97e00', '"NaN"'], ['f9fc00', '"-Infinity"'],
  ['f4', 'false'], ['f5', 'true'], ['f6', 'null'], ['f7', 'null'], ['c074323031332d30332d32315432303a30343a30305a', '"2013-03-21T20:04:00Z"'],
  ['c11a514b67b0', '"2013-03-21T20:04:00Z"'], ['c1fb41d452d9ec200000', '"2013-03-21T20:04:00.500Z"'], ['40', '""'], ['4401020304', '"AQIDBA=="'],
  ['60', '""'], ['6161', '"a"'], ['6449455446', '"IETF"'], ['62225c', '"\\"\\\\"'], ['62c3bc', '"ü"'], ['63e6b0b4', '"水"'],
  ['80', '[]'], ['83010203', '[1,2,3]'], ['8301820203820405', '[1,[2,3],[4,5]]'], ['a0', '{}'], ['a201020304', '{"1":2,"3":4}'],
  ['a26161016162820203', '{"a":1,"b":[2,3]}'], ['826161a161626163', '["a",{"b":"c"}]'], ['5f42010243030405ff', '"AQIDBAU="'],
  ['7f657374726561646d696e67ff', '"streaming"'], ['9fff', '[]'], ['9f018202039f0405ffff', '[1,[2,3],[4,5]]'], ['9f01820203820405ff', '[1,[2,3],[4,5]]'],
  ['bf61610161629f0203ffff', '{"a":1,"b":[2,3]}'], ['826161bf61626163ff', '["a",{"b":"c"}]'], ['bf6346756ef563416d7421ff', '{"Fun":true,"Amt":-2}'],
];
test('cbor: the RFC 8949 Appendix A examples read as their values', () => {
  for (const [h, want] of APPX) assert.equal(plain(one('cbor', h)), want, h);
  assert.equal(one('cbor', 'f0').v, 16);
  assert.equal(one('cbor', 'f8ff').v, 255);
  assert.equal(one('cbor', 'f818').v, 24); // RFC 7049 form, read as it is
});
test('cbor: labels, tags and the writer (preferred forms, the examples marked round trip)', () => {
  const s = new Session(hx('d82076687474703a2f2f7777772e6578616d706c652e636f6d'), 'cbor');
  const r = s.children(0).rows[0];
  assert.deepEqual([r.type, r.preview], ['tag 32', 'URI: "http://www.example.com"']);
  for (const h of ['00', '1818', '1bffffffffffffffff', 'c249010000000000000000', '3903e7', 'fb3ff199999999999a', 'f93c00', '6449455446', '8301820203820405', 'a26161016162820203', 'c11a514b67b0']) {
    const v = one('cbor', h);
    assert.equal(W.encodeOne('cbor', V.lower(v, 'cbor')).toString('hex'), h, h);
  }
  assert.equal(W.encodeOne('cbor', { t: 'float', v: 0.1, w: 16 }).toString('hex'), 'fb3fb999999999999a');
  const sensor = W.decodeAll('cbor', fs.readFileSync(path.join(SAMPLES, 'sensor.cbor')));
  assert.equal(sensor.length, 1);
  assert.equal(sensor[0].t, 'tag');
  assert.equal(sensor[0].tag, 55799n);
});
test('cbor: bad data gives the byte offset', () => {
  assert.match(errOf('cbor', 'a1 61 61 1c').message, /reserved additional value 28/);
  assert.equal(errOf('cbor', 'a1 61 61 1c').off, 3);
  assert.match(errOf('cbor', '81 ff').message, /"break" byte \(0xFF\) at byte 1/);
  assert.match(errOf('cbor', '1f').message, /cannot have an indefinite length/);
  assert.match(errOf('cbor', '9f 01 02').message, /indefinite array that starts at byte 0 \(0x0\) has no "break" byte/);
  assert.match(errOf('cbor', 'bf 61 61 ff').message, /key with no value/);
  assert.match(errOf('cbor', '5f 61 61 ff').message, /chunk of the indefinite byte string.*must be a byte string too/);
  assert.match(errOf('cbor', '65 61 62').message, /ends early/);
});

// ---------- BSON ----------
test('bson: our users sample, every element type, labels and offsets', () => {
  const b = fs.readFileSync(path.join(SAMPLES, 'users.bson'));
  const s = new Session(b, 'bson', 'users.bson');
  assert.equal(s.count, 3);
  const top = s.children(0);
  const kids = s.children(top.rows[0].id).rows;
  const by = Object.fromEntries(kids.map((r) => [r.key, r]));
  assert.deepEqual([by._id.type, by._id.preview, by._id.off], ['ObjectId', '6745a1c2e4b0f13a9c2d7e01', 9]);
  assert.deepEqual([by.age.type, by.visits.type, by.visits.preview], ['int32', 'int64', '9007199254740993']);
  assert.deepEqual([by.balance.type, by.balance.preview], ['decimal128', '1250.75']);
  assert.deepEqual([by.joined.type, by.joined.preview], ['UTC datetime', '2025-03-14T10:20:30.400Z']);
  assert.deepEqual([by.token.type, by.token.preview], ['binary (subtype 4: UUID)', '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d']);
  assert.deepEqual([by.pattern.preview, by.lastSync.preview, by.address.preview, by.roles.preview], ['/^ana/i', 't=1763540000, i=7', '{2 keys}', '[2 items]']);
  const d = s.details(by._id.id);
  assert.equal(d.elemOff, 4);
  assert.match(d.facts.find((f) => f[0] === 'Created')[1], /^2024-11-26T10:24:02Z/);
  assert.match(d.hex, /^00000004 {2}07 5f 69 64 00 67 45/);
  const vals = W.decodeAll('bson', b);
  assert.ok(W.encodeAll('bson', V.fromJsonText(typed({ t: 'arr', v: vals }))[0].v).equals(b));
});
test('bson: decimal128 text both ways (canonical bytes and the spec text forms)', () => {
  const cases = [['0', '00000000000000000000000000004030'], ['1', '01000000000000000000000000004030'], ['-1', '010000000000000000000000000040b0'], ['0.1', '0100000000000000000000000000' + '3e30'],
    ['NaN', '0000000000000000000000000000007c'], ['Infinity', '00000000000000000000000000000078'], ['-Infinity', '000000000000000000000000000000f8']];
  for (const [t, h] of cases) { assert.equal(bson.decimalBytes(t).toString('hex'), h, t); assert.equal(bson.decimalText(hx(h)), t, t); }
  for (const t of ['1.5E+3', '1E+3', '0.000001', '1E-7', '-0', '12345678901234567890123456789012.34', '9.999999999999999999999999999999999E+6144', '1E-6176']) assert.equal(bson.decimalText(bson.decimalBytes(t)), t, t);
  assert.equal(bson.decimalText(bson.decimalBytes('1250.75')), '1250.75');
  assert.equal(bson.decimalBytes('1.2.3'), null);
  assert.equal(bson.decimalBytes('1'.repeat(35)), null);
});
test('bson: bad documents give the byte offset; a damaged document in a dump is marked and the rest still read', () => {
  assert.match(errOf('bson', '04000000').message, /at least 5 bytes/);
  assert.match(errOf('bson', '0a00000010610001').message, /ends early.*says it is 10 bytes long/);
  assert.match(errOf('bson', '0c0000001061000100000001').message, /should end with a 0 byte at byte 11/);
  assert.match(errOf('bson', '0c0000002061000100000000').message, /Unknown BSON element type 0x20 at byte 4/);
  assert.match(errOf('bson', '0d000000026100ffffffff0000').message, /string at byte 7.*says it is -1 bytes/);
  assert.match(errOf('bson', '0900000008610005 00').message, /boolean at byte 7.*0x5/);
  const good = W.encodeOne('bson', { t: 'map', v: [[{ t: 'str', v: 'a' }, { t: 'int', v: 1n }]] });
  const bad = Buffer.from(good); bad[4] = 0x20;
  const s = new Session(Buffer.concat([good, bad, good]), 'bson');
  const top = s.children(0);
  assert.deepEqual(top.rows.map((r) => r.broken), [false, true, false]);
  assert.equal(s.top.err.off, 16);
  assert.match(s.children(top.rows[1].id).err.message, /Unknown BSON element type 0x20/);
});
test('bson: code with scope, DBPointer, symbol, MinKey and MaxKey read and write back', () => {
  const v = { t: 'map', v: [['c', { t: 'code', v: 'x+1', scope: { t: 'map', v: [[{ t: 'str', v: 'x' }, { t: 'int', v: 1n }]] } }], ['p', { t: 'dbptr', ns: 'db.c', id: hx('6745a1c2e4b0f13a9c2d7e01') }], ['s', { t: 'symbol', v: 'sym' }], ['lo', { t: 'minkey' }], ['hi', { t: 'maxkey' }], ['u', { t: 'undef' }]].map(([k, x]) => [{ t: 'str', v: k }, x]) };
  const b = W.encodeOne('bson', v);
  const back = W.decodeAll('bson', b)[0];
  assert.equal(typed(back), typed(v));
  assert.equal(typed(back), '{"c":{"$code":"x+1","$scope":{"x":1}},"p":{"$dbPointer":{"$ref":"db.c","$id":{"$oid":"6745a1c2e4b0f13a9c2d7e01"}}},"s":{"$symbol":"sym"},"lo":{"$minKey":1},"hi":{"$maxKey":1},"u":{"$undefined":true}}');
  const s = new Session(b, 'bson');
  const kids = s.children(s.children(0).rows[0].id).rows;
  assert.deepEqual(kids.map((r) => r.type), ['code with scope (deprecated)', 'DBPointer (deprecated)', 'symbol (deprecated)', 'MinKey', 'MaxKey', 'undefined (deprecated)']);
  assert.deepEqual(s.children(kids[0].id).rows.map((r) => [r.key, r.preview]), [['$code', '"x+1"'], ['$scope', '{1 key}']]);
});

// ---------- JSON forms ----------
test('json: plain JSON is readable; typed JSON reads back every type exactly', () => {
  const all = { t: 'map', v: [
    ['i', { t: 'int', v: -5n }], ['big', { t: 'int', v: 2n ** 64n - 1n }], ['l', { t: 'int', v: 3n, w: 64 }], ['f', { t: 'float', v: 2, w: 64 }], ['f32', { t: 'float', v: 0.5, w: 32 }],
    ['nan', { t: 'float', v: NaN, w: 64 }], ['s', { t: 'str', v: 'a"b' }], ['b', { t: 'bin', v: hx('0102'), sub: 4 }], ['e', { t: 'ext', type: -3, v: hx('ff') }],
    ['d', { t: 'date', s: 0n, ns: 1 }], ['tag', { t: 'tag', tag: 99n, v: { t: 'null' } }], ['simple', { t: 'simple', v: 5 }], ['dec', { t: 'dec128', v: bson.decimalBytes('1.50') }],
    ['re', { t: 'regex', p: 'a.*', f: 'i' }], ['ts', { t: 'bts', tm: 5, i: 6 }], ['arr', { t: 'arr', v: [{ t: 'bool', v: true }] }],
    ['keys', { t: 'map', v: [[{ t: 'int', v: 1n }, { t: 'str', v: 'x' }]] }], ['looks', { t: 'map', v: [[{ t: 'str', v: '$oid' }, { t: 'str', v: 'not an id' }]] }],
  ].map(([k, x]) => [{ t: 'str', v: k }, x]) };
  const t = typed(all);
  assert.equal(typed(V.fromJsonText(t)[0]), t);
  assert.match(t, /"f":2\.0,/);
  assert.match(t, /"big":18446744073709551615/);
  assert.match(t, /"looks":\{"\$map":\[\["\$oid","not an id"\]\]\}/);
  const p = plain(all);
  assert.match(p, /"f":2,"f32":0.5,"nan":"NaN"/);
  assert.match(p, /"b":"AQI=","e":\{"\$ext":\{"type":-3,"base64":"\/w=="\}\},"d":"1970-01-01T00:00:00.000000001Z"/);
  assert.match(p, /"dec":1.50,"re":"\/a\.\*\/i"/);
  assert.match(p, /"keys":\{"1":"x"\}/);
});
test('json: our reader keeps 1 and 1.0 apart, big integers whole, and names the line and column of an error', () => {
  const [v] = V.parseJsonValues('{"a": 1, "b": 1.0, "c": 123456789012345678901234567890, "d": [true, null, "x\\u00e9"]}');
  assert.deepEqual(v.v.map(([, x]) => x.t), ['int', 'float', 'int', 'arr']);
  assert.equal(v.v[2][1].v, 123456789012345678901234567890n);
  assert.equal(v.v[3][1].v[2].v, 'xé');
  assert.throws(() => V.parseJsonValues('{\n  "a": 1,\n  "b": }'), /line 3, column 8/);
  assert.equal(V.parseJsonValues('{"a":1}\n{"a":2}\n', { many: true }).length, 2);
  assert.throws(() => V.fromJsonText('{"$oid": "zz"}'), /\$oid needs 24 hex digits/);
});
test('lower: types a format has no form for become typed-JSON maps; CBOR tags become dates and integers elsewhere', () => {
  const oid = { t: 'oid', v: hx('6745a1c2e4b0f13a9c2d7e01') };
  assert.equal(plain(V.lower(oid, 'msgpack')), '{"$oid":"6745a1c2e4b0f13a9c2d7e01"}');
  assert.equal(V.lower({ t: 'tag', tag: 1n, v: { t: 'int', v: 10n } }, 'bson').t, 'date');
  assert.equal(V.lower({ t: 'tag', tag: 2n, v: { t: 'bin', v: hx('0100') } }, 'msgpack').v, 256n);
  assert.equal(plain(V.lower({ t: 'map', v: [[{ t: 'int', v: 1n }, { t: 'null' }]] }, 'bson')), '{"$map":[[1,null]]}');
  assert.equal(plain(V.lower({ t: 'ext', type: 1, v: hx('00') }, 'cbor')), '{"$ext":{"type":1,"base64":"AA=="}}');
  assert.throws(() => W.encodeOne('bson', { t: 'arr', v: [] }), /BSON files hold documents/);
});

// ---------- comparison ----------
test('diff: added, removed, changed values and changed types, with paths', () => {
  const [a] = V.fromJsonText('{"id": 1, "name": "x", "tags": ["a", "b"], "n": 1, "deep": {"k": true}, "gone": 0}');
  const [b] = V.fromJsonText('{"id": 1, "name": "y", "tags": ["a"], "n": 1.0, "deep": {"k": true, "new": null}, "odd key": 2}');
  const r = V.diff(a, b);
  assert.deepEqual(r.rows.map((x) => [x.path, x.kind]), [['name', 'changed'], ['tags[1]', 'removed'], ['n', 'type'], ['deep.new', 'added'], ['gone', 'removed'], ['["odd key"]', 'added']]);
  assert.deepEqual(r.counts, { added: 2, removed: 2, changed: 1, type: 1, same: 3 });
  assert.equal(r.rows[0].a, '"x"');
  assert.equal(r.rows[2].b, 'float: 1.0');
  assert.equal(V.diff(a, a).total, 0);
  assert.equal(V.diff({ t: 'float', v: 0.75, w: 32 }, { t: 'float', v: 0.75, w: 64 }).total, 0);
  assert.equal(V.diff({ t: 'int', v: 7n, w: 32 }, { t: 'int', v: 7n, w: 64 }).total, 0);
  assert.equal(V.diff({ t: 'float', v: NaN, w: 64 }, { t: 'float', v: NaN, w: 64 }).total, 0);
});

// ---------- one-value edits ----------
test('splice: a MessagePack string grows; every other byte stays the same', () => {
  const b = fs.readFileSync(path.join(SAMPLES, 'orders.msgpack'));
  const s = new Session(b, 'msgpack');
  const second = s.children(0).rows[1];
  const customer = s.children(second.id).rows.find((r) => r.key === 'customer');
  const r = W.spliceValue('msgpack', b, s.chain(customer.id), { t: 'str', v: 'C-0187 (moved to the new account)' });
  assert.equal(r.oldLen, 7);
  assert.ok(r.bytes.subarray(0, customer.off).equals(b.subarray(0, customer.off)));
  assert.ok(r.bytes.subarray(customer.off + r.newLen).equals(b.subarray(customer.off + 7)));
  const vals = W.decodeAll('msgpack', r.bytes);
  assert.equal(vals.length, 3);
  assert.equal(vals[1].v.find(([k]) => k.v === 'customer')[1].v, 'C-0187 (moved to the new account)');
});
test('splice: BSON lengths of every document around the value are corrected, also when the type changes', () => {
  const b = fs.readFileSync(path.join(SAMPLES, 'users.bson'));
  const s = new Session(b, 'bson');
  const doc = s.children(0).rows[0];
  const address = s.children(doc.id).rows.find((r) => r.key === 'address');
  const city = s.children(address.id).rows.find((r) => r.key === 'city');
  const r = W.spliceValue('bson', b, s.chain(city.id), { t: 'str', v: 'Vila Nova de Gaia' });
  const vals = W.decodeAll('bson', r.bytes);
  assert.equal(plain(vals[0].v.find(([k]) => k.v === 'address')[1]), '{"city":"Vila Nova de Gaia","zip":"4000-001"}');
  assert.equal(r.bytes.readInt32LE(0), b.readInt32LE(0) + 12);
  assert.equal(plain(vals[1]), plain(W.decodeAll('bson', b)[1]));
  const age = s.children(doc.id).rows.find((x) => x.key === 'age');
  const r2 = W.spliceValue('bson', b, s.chain(age.id), { t: 'str', v: 'thirty-four' });
  assert.equal(W.decodeAll('bson', r2.bytes)[0].v.find(([k]) => k.v === 'age')[1].v, 'thirty-four');
});
test('splice: a value inside a CBOR indefinite array and inside a tag', () => {
  const b = fs.readFileSync(path.join(SAMPLES, 'sensor.cbor'));
  const s = new Session(b, 'cbor');
  const map = s.children(s.children(0).rows[0].id).rows[0];
  const samples = s.children(map.id).rows.find((r) => r.key === 'samples');
  const third = s.children(samples.id).rows[2];
  const r = W.spliceValue('cbor', b, s.chain(third.id), { t: 'int', v: 1000n });
  assert.match(plain(W.decodeAll('cbor', r.bytes)[0]), /"samples":\[1,2,1000,42\]/);
  const at = s.children(map.id).rows.find((x) => x.key === 'at');
  const inner = s.children(at.id).rows[0];
  const r2 = W.spliceValue('cbor', b, s.chain(inner.id), { t: 'int', v: 0n });
  assert.match(plain(W.decodeAll('cbor', r2.bytes)[0]), /"at":"1970-01-01T00:00:00Z"/);
});
test('edit box: the start text and the reading of the new value per type', () => {
  const s = new Session(fs.readFileSync(path.join(SAMPLES, 'users.bson')), 'bson');
  const kids = s.children(s.children(0).rows[0].id).rows;
  const node = (k) => s.nodes.get(kids.find((r) => r.key === k).id).item;
  assert.equal(editText(node('joined')), '2025-03-14T10:20:30.400Z');
  assert.equal(editText(node('balance')), '1250.75');
  assert.deepEqual(parseEdit(node('age'), ' 35 ', 'bson').v, { t: 'int', v: 35n, w: 32 });
  assert.match(parseEdit(node('age'), 'abc', 'bson').error, /whole number/);
  assert.equal(parseEdit(node('age'), '"text"', 'bson').v.t, 'str');
  assert.equal(parseEdit(node('joined'), '2026-01-02T03:04:05Z', 'bson').v.s, 1767323045n);
  assert.match(parseEdit(node('_id'), 'xyz', 'bson').error, /24 hex digits/);
  assert.equal(parseEdit(node('_id'), '123', 'bson').v.t, 'int');
  assert.equal(parseEdit(node('score'), 'NaN', 'bson').v.t, 'float');
  assert.equal(parseEdit(node('name'), 'any "text"', 'bson').v.v, 'any "text"');
  assert.equal(parseEdit(node('token'), '00 11', 'bson').v.sub, 4);
});

// ---------- viewer session ----------
test('session: children 500 at a time, search with paths, JSON of a node, Git LFS and JSON-text hints', () => {
  const big = W.encodeOne('msgpack', { t: 'arr', v: Array.from({ length: 1200 }, (_, i) => ({ t: 'map', v: [[{ t: 'str', v: 'n' }, { t: 'int', v: BigInt(i) }]] })) });
  const s = new Session(big, 'msgpack');
  const root = s.children(0).rows[0];
  assert.equal(root.key, '(root)');
  const p1 = s.children(root.id);
  assert.deepEqual([p1.rows.length, p1.more, p1.total], [500, true, 1200]);
  assert.equal(s.children(root.id, 1000).rows.length, 200);
  const r = s.search('1199');
  assert.deepEqual(r.hits.map((h) => h.path), ['[1199].n']);
  const n = s.nodeAt(r.hits[0].chain);
  assert.equal(n.path, '[1199].n');
  assert.equal(s.json(n.id).text, '1199');
  const k = s.search('N');
  assert.equal(k.hits.length, 500);
  assert.ok(k.more);
  assert.equal(fmtOfName('A.MPK'), 'msgpack');
  assert.equal(fmtOfName('x.Bson'), 'bson');
  assert.match(textHint(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n'), 'msgpack'), /Git LFS pointer/);
  assert.match(textHint(Buffer.from('[\n  {"a": 1}\n]\n'), 'bson'), /JSON text, not BSON/);
  assert.equal(textHint(fs.readFileSync(path.join(SAMPLES, 'users.bson')), 'bson'), '');
});
