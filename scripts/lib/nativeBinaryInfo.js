'use strict';

/**
 * Header-only inspection of native binaries (ELF, Mach-O, PE).
 *
 * The packaging proof (documentation/packaging_proof.md) needs three facts
 * about every shipped binary that a host without the matching toolchain
 * cannot get from `ldd`/`otool`/`dumpbin`: which CPU architecture it was
 * built for, the oldest operating system that can load it (the glibc symbol
 * versions an ELF needs, the macOS deployment target of a Mach-O) and which
 * shared libraries it expects the machine to provide (DT_NEEDED, dylib
 * load commands, PE import tables). Everything here reads headers through
 * file descriptors, so a 100 MB runtime costs a few kilobytes of I/O, and it
 * has no dependencies, so it also runs inside the payload with its bundled
 * Node.
 */

const fs = require('node:fs');

const BINARY_NAME = /\.(node|dll|dylib|exe)$|\.so(\.\d+)*$/i;

const ELF_MACHINES = { 3: 'ia32', 40: 'arm', 62: 'x64', 183: 'arm64' };
const MACHO_CPUS = { 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32', 12: 'arm' };
const PE_MACHINES = { 0x014c: 'ia32', 0x8664: 'x64', 0xaa64: 'arm64', 0x01c4: 'arm' };

function readAt(fd, position, length) {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, position);
    return read === length ? buffer : buffer.subarray(0, read);
}

function cString(buffer, offset) {
    let end = offset;
    while (end < buffer.length && buffer[end] !== 0) end += 1;
    return buffer.toString('latin1', offset, end);
}

/** Compare dotted numeric versions ("2.9" < "2.28"). */
function compareVersions(a, b) {
    const left = String(a).split('.').map(Number);
    const right = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const diff = (left[i] || 0) - (right[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function maxVersion(versions) {
    return versions.length ? versions.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b)) : null;
}

function inspectElf(fd, head) {
    const is64 = head[4] === 2;
    const little = head[5] === 1;
    if (!little) return { format: 'elf', arch: ['unknown'], note: 'big-endian ELF is not inspected' };
    const machine = head.readUInt16LE(18);
    const info = { format: 'elf', arch: [ELF_MACHINES[machine] || `machine-${machine}`], needed: [], symbolVersions: {} };
    if (!is64) return info;

    const shoff = Number(head.readBigUInt64LE(0x28));
    const shentsize = head.readUInt16LE(0x3a);
    const shnum = head.readUInt16LE(0x3c);
    if (!shoff || !shnum) return info;
    const table = readAt(fd, shoff, shentsize * shnum);
    const sections = [];
    for (let i = 0; i < shnum; i += 1) {
        const base = i * shentsize;
        sections.push({
            type: table.readUInt32LE(base + 4),
            offset: Number(table.readBigUInt64LE(base + 0x18)),
            size: Number(table.readBigUInt64LE(base + 0x20)),
            link: table.readUInt32LE(base + 0x28)
        });
    }
    const strings = (index) => {
        const section = sections[index];
        return section ? readAt(fd, section.offset, section.size) : Buffer.alloc(0);
    };

    const SHT_DYNAMIC = 6;
    const SHT_GNU_VERNEED = 0x6ffffffe;
    for (const section of sections) {
        if (section.type === SHT_DYNAMIC) {
            const names = strings(section.link);
            const entries = readAt(fd, section.offset, section.size);
            for (let at = 0; at + 16 <= entries.length; at += 16) {
                const tag = Number(entries.readBigInt64LE(at));
                if (tag === 0) break;
                if (tag === 1) info.needed.push(cString(names, Number(entries.readBigUInt64LE(at + 8))));
            }
        } else if (section.type === SHT_GNU_VERNEED) {
            const names = strings(section.link);
            const data = readAt(fd, section.offset, section.size);
            let at = 0;
            for (;;) {
                if (at + 16 > data.length) break;
                const count = data.readUInt16LE(at + 2);
                const file = cString(names, data.readUInt32LE(at + 4));
                let aux = at + data.readUInt32LE(at + 8);
                for (let i = 0; i < count && aux + 16 <= data.length; i += 1) {
                    const name = cString(names, data.readUInt32LE(aux + 8));
                    (info.symbolVersions[file] ||= []).push(name);
                    const next = data.readUInt32LE(aux + 12);
                    if (!next) break;
                    aux += next;
                }
                const next = data.readUInt32LE(at + 12);
                if (!next) break;
                at += next;
            }
        }
    }

    const collect = (prefix) => maxVersion(Object.values(info.symbolVersions).flat()
        .filter(name => name.startsWith(prefix)).map(name => name.slice(prefix.length)));
    info.glibcMin = collect('GLIBC_');
    info.glibcxxMin = collect('GLIBCXX_');
    info.cxxabiMin = collect('CXXABI_');
    return info;
}

function inspectMachoSlice(fd, offset) {
    const header = readAt(fd, offset, 32);
    if (header.length < 32 || header.readUInt32LE(0) !== 0xfeedfacf) {
        return { arch: 'unknown' };
    }
    const cpu = header.readUInt32LE(4);
    const slice = { arch: MACHO_CPUS[cpu] || `cpu-${cpu.toString(16)}`, dylibs: [] };
    const ncmds = header.readUInt32LE(16);
    const commands = readAt(fd, offset + 32, header.readUInt32LE(20));
    const toVersion = (packed) => `${packed >>> 16}.${(packed >>> 8) & 0xff}.${packed & 0xff}`;
    let at = 0;
    for (let i = 0; i < ncmds && at + 8 <= commands.length; i += 1) {
        const cmd = commands.readUInt32LE(at);
        const size = commands.readUInt32LE(at + 4);
        if (cmd === 0x32) slice.minOs = toVersion(commands.readUInt32LE(at + 12)); // LC_BUILD_VERSION
        else if (cmd === 0x24) slice.minOs = toVersion(commands.readUInt32LE(at + 8)); // LC_VERSION_MIN_MACOSX
        else if (cmd === 0xc || cmd === 0x80000018 || cmd === 0x8000001f) {
            slice.dylibs.push(cString(commands, at + commands.readUInt32LE(at + 8)));
        }
        if (!size) break;
        at += size;
    }
    return slice;
}

function inspectMacho(fd, head) {
    const slices = [];
    if (head.readUInt32BE(0) === 0xcafebabe) {
        const count = head.readUInt32BE(4);
        const table = readAt(fd, 8, count * 20);
        for (let i = 0; i < count; i += 1) slices.push(inspectMachoSlice(fd, table.readUInt32BE(i * 20 + 8)));
    } else {
        slices.push(inspectMachoSlice(fd, 0));
    }
    const minOs = slices.map(slice => slice.minOs).filter(Boolean);
    return {
        format: 'macho',
        arch: slices.map(slice => slice.arch),
        needed: [...new Set(slices.flatMap(slice => slice.dylibs || []))],
        minMacos: maxVersion(minOs)
    };
}

function inspectPe(fd, head) {
    const peOffset = head.readUInt32LE(0x3c);
    const header = readAt(fd, peOffset, 24 + 240);
    if (header.toString('latin1', 0, 4) !== 'PE\0\0') return { format: 'unknown', arch: ['unknown'] };
    const machine = header.readUInt16LE(4);
    const sectionCount = header.readUInt16LE(6);
    const optionalSize = header.readUInt16LE(20);
    const info = { format: 'pe', arch: [PE_MACHINES[machine] || `machine-${machine.toString(16)}`], needed: [] };
    const optional = 24;
    if (header.readUInt16LE(optional) !== 0x20b) return info; // only PE32+ has the offsets below

    const sections = [];
    const sectionTable = readAt(fd, peOffset + 24 + optionalSize, sectionCount * 40);
    for (let i = 0; i < sectionCount; i += 1) {
        const base = i * 40;
        sections.push({
            virtualSize: sectionTable.readUInt32LE(base + 8),
            virtualAddress: sectionTable.readUInt32LE(base + 12),
            rawSize: sectionTable.readUInt32LE(base + 16),
            rawOffset: sectionTable.readUInt32LE(base + 20)
        });
    }
    const toOffset = (rva) => {
        const section = sections.find(s => rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.virtualSize, s.rawSize));
        return section ? section.rawOffset + (rva - section.virtualAddress) : null;
    };
    const dataDirectory = (index) => ({
        rva: header.readUInt32LE(optional + 112 + index * 8),
        size: header.readUInt32LE(optional + 112 + index * 8 + 4)
    });
    const readName = (rva) => {
        const at = toOffset(rva);
        return at === null ? null : cString(readAt(fd, at, 256), 0);
    };
    const walk = (directory, stride, nameField) => {
        const at = directory.rva ? toOffset(directory.rva) : null;
        if (at === null || !directory.size) return;
        const raw = readAt(fd, at, directory.size);
        for (let base = 0; base + stride <= raw.length; base += stride) {
            const nameRva = raw.readUInt32LE(base + nameField);
            if (!nameRva) break;
            const name = readName(nameRva);
            if (name) info.needed.push(name);
        }
    };
    walk(dataDirectory(1), 20, 12); // import table
    walk(dataDirectory(13), 32, 4); // delay-load imports
    info.needed = [...new Set(info.needed)];
    return info;
}

/**
 * @param {string} file
 * @returns {{ format: 'elf'|'macho'|'pe'|'unknown', arch: string[], needed?: string[],
 *   glibcMin?: string|null, glibcxxMin?: string|null, cxxabiMin?: string|null, minMacos?: string|null }}
 */
function inspectBinary(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const head = readAt(fd, 0, 0x40);
        if (head.length >= 20 && head.readUInt32BE(0) === 0x7f454c46) return inspectElf(fd, head);
        if (head.length >= 8) {
            const magic = head.readUInt32LE(0);
            if (magic === 0xfeedfacf || head.readUInt32BE(0) === 0xcafebabe) return inspectMacho(fd, head);
        }
        if (head.length >= 0x40 && head[0] === 0x4d && head[1] === 0x5a) return inspectPe(fd, head);
        return { format: 'unknown', arch: ['unknown'] };
    } finally {
        fs.closeSync(fd);
    }
}

function looksLikeBinary(relPath) {
    return BINARY_NAME.test(relPath);
}

module.exports = { inspectBinary, looksLikeBinary, compareVersions, maxVersion, BINARY_NAME };
