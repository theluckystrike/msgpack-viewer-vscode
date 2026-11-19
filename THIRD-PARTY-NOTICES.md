# Third-party notices

The extension ships no third-party code. The MessagePack, CBOR and BSON readers and writers, the JSON reader, the typed JSON forms, the comparison and the viewer are written for this extension from the public format specifications: the MessagePack specification, RFC 8949 (CBOR) with RFC 8742 (CBOR sequences), and the BSON 1.1 specification. The typed JSON wrappers follow the names of the MongoDB Extended JSON format so that such files read in other tools.

## Sample files

samples/orders.msgpack, samples/sensor.cbor and samples/users.bson hold made-up data. They were written for this extension by scripts/make-samples.js (MIT, like the extension).
