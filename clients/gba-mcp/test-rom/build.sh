#!/usr/bin/env bash
# Build keytest.gba, the harness test ROM.
# Requires: gcc-arm-none-eabi (Debian/Ubuntu: apt install gcc-arm-none-eabi) and Node.
set -euo pipefail
cd "$(dirname "$0")"

arm-none-eabi-gcc -mcpu=arm7tdmi -marm -O2 -ffreestanding -nostdlib \
    -fomit-frame-pointer -Wall -Wextra \
    crt0.s main.c -T rom.ld -o keytest.elf
arm-none-eabi-objcopy -O binary keytest.elf keytest.gba
node fixheader.js keytest.gba
echo "Built keytest.gba ($(stat -c%s keytest.gba) bytes)"
