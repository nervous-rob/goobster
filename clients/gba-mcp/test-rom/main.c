/*
 * keytest — a tiny homebrew GBA ROM for exercising the Goobster GBA
 * harness without a commercial game.
 *
 * Mode 3 bitmap. A 16x16 square starts centered and is moved by the
 * D-pad; A turns it red, B turns it yellow, START recenters it. The top
 * bar shows a white marker that sweeps with the frame counter, so `wait`
 * calls are visible too. Every harness capability (buttons, waiting,
 * save/load state, screenshots) produces an unambiguous pixel change.
 */

#define REG_DISPCNT  (*(volatile unsigned short *)0x04000000)
#define REG_VCOUNT   (*(volatile unsigned short *)0x04000006)
#define REG_KEYINPUT (*(volatile unsigned short *)0x04000130)

#define SCREEN_W 240
#define SCREEN_H 160
#define BAR_H 8
#define SQUARE 16

#define KEY_A      (1 << 0)
#define KEY_B      (1 << 1)
#define KEY_START  (1 << 3)
#define KEY_RIGHT  (1 << 4)
#define KEY_LEFT   (1 << 5)
#define KEY_UP     (1 << 6)
#define KEY_DOWN   (1 << 7)

/* BGR555 colors */
#define COL_BG     0x3000  /* dark blue  */
#define COL_BAR    0x0842  /* dark gray  */
#define COL_MARK   0x7FFF  /* white      */
#define COL_SQUARE 0x7FFF  /* white      */
#define COL_RED    0x001F  /* red (low 5 bits) */
#define COL_YELLOW 0x03FF  /* red+green  */

static volatile unsigned short *const vram = (volatile unsigned short *)0x06000000;

static void fill_rect(int x0, int y0, int w, int h, unsigned short color) {
    for (int y = y0; y < y0 + h; y++) {
        volatile unsigned short *row = vram + y * SCREEN_W + x0;
        for (int x = 0; x < w; x++) {
            row[x] = color;
        }
    }
}

static void vsync(void) {
    while (REG_VCOUNT >= 160) {}
    while (REG_VCOUNT < 160) {}
}

int main(void) {
    REG_DISPCNT = 0x0403; /* mode 3, BG2 on */

    int px = (SCREEN_W - SQUARE) / 2;
    int py = (SCREEN_H - SQUARE) / 2;
    int old_px = px, old_py = py;
    unsigned frame = 0;

    fill_rect(0, 0, SCREEN_W, BAR_H, COL_BAR);
    fill_rect(0, BAR_H, SCREEN_W, SCREEN_H - BAR_H, COL_BG);

    for (;;) {
        vsync();
        unsigned keys = ~REG_KEYINPUT & 0x3FF;

        if (keys & KEY_RIGHT) px += 2;
        if (keys & KEY_LEFT)  px -= 2;
        if (keys & KEY_DOWN)  py += 2;
        if (keys & KEY_UP)    py -= 2;
        if (keys & KEY_START) { px = (SCREEN_W - SQUARE) / 2; py = (SCREEN_H - SQUARE) / 2; }

        if (px < 0) px = 0;
        if (px > SCREEN_W - SQUARE) px = SCREEN_W - SQUARE;
        if (py < BAR_H) py = BAR_H;
        if (py > SCREEN_H - SQUARE) py = SCREEN_H - SQUARE;

        unsigned short color = COL_SQUARE;
        if (keys & KEY_A) color = COL_RED;
        else if (keys & KEY_B) color = COL_YELLOW;

        /* erase, redraw square */
        fill_rect(old_px, old_py, SQUARE, SQUARE, COL_BG);
        fill_rect(px, py, SQUARE, SQUARE, color);
        old_px = px;
        old_py = py;

        /* frame marker sweeping the top bar */
        fill_rect(0, 0, SCREEN_W, BAR_H, COL_BAR);
        fill_rect(frame % (SCREEN_W - 4), 0, 4, BAR_H, COL_MARK);
        frame++;
    }
}
