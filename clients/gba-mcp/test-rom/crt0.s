@ Minimal GBA cartridge entry: header + jump to C main.
@ The 192-byte cartridge header starts with a branch over itself; the
@ remaining header fields (title, code, complement) are filled in by
@ fixheader.js after objcopy.

    .section .init, "ax"
    .arm
    .global _start
_start:
    b rom_start
    .space 0xBC             @ rest of the 0xC0-byte cartridge header

rom_start:
    ldr sp, =0x03007F00     @ user stack top in IWRAM
    ldr r0, =main
    bx r0
1:  b 1b
    .ltorg
