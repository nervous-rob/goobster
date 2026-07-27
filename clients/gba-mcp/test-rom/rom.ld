/* Minimal GBA cartridge layout: everything in ROM at 0x08000000. */
ENTRY(_start)

MEMORY {
    rom (rx) : ORIGIN = 0x08000000, LENGTH = 32M
}

SECTIONS {
    .text : {
        KEEP(*(.init))
        *(.text*)
        *(.rodata*)
    } > rom
}
