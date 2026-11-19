# Bad data and byte offsets

Every row of the tree shows where its value starts in the file (Offset) and how many bytes it takes (Bytes). The details on the right show the same numbers in decimal and hex, and the first 256 bytes of the value.

When reading stops, a note above the tree names the byte and the reason, for example a type byte that MessagePack never uses, a string that is longer than the rest of the file, or a BSON document whose length does not fit. Every value before that byte still shows. The damaged value has a wavy underline: open it to see how far it reads.

If the bytes are really another of the three formats, pick it under Read as.
