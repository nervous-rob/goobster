#!/usr/bin/env node
/**
 * Fill in the GBA cartridge header fields (title, game code, fixed byte,
 * header complement) of a raw ROM produced by objcopy. Without a valid
 * complement some emulators and flashcarts refuse the ROM.
 *
 * Usage: node fixheader.js <rom.gba>
 */

const fs = require('node:fs');

const file = process.argv[2];
if (!file) {
    console.error('usage: node fixheader.js <rom.gba>');
    process.exit(1);
}

const rom = fs.readFileSync(file);
if (rom.length < 0xc0) {
    console.error('ROM smaller than the 0xC0-byte GBA header');
    process.exit(1);
}

rom.fill(0, 0xa0, 0xc0);
rom.write('GOOBKEYTEST', 0xa0, 'ascii');  // title (12 bytes, padded)
rom.write('GKTE', 0xac, 'ascii');         // game code
rom.write('GB', 0xb0, 'ascii');           // maker code
rom[0xb2] = 0x96;                         // fixed value
// 0xB3..0xBC stay zero (unit code, device type, reserved, version)

let checksum = 0;
for (let i = 0xa0; i <= 0xbc; i++) checksum += rom[i];
rom[0xbd] = (-(0x19 + checksum)) & 0xff;  // header complement

fs.writeFileSync(file, rom);
console.log(`${file}: header fixed (complement 0x${rom[0xbd].toString(16)})`);
