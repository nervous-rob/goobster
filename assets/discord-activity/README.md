# Discord Activity assets — Goobster Casino

Upload these in the [Discord Developer Portal](https://discord.com/developers/applications)
under **Activities → Art Assets** for the application the bot runs under.
Portal updates may take a while to show up due to caching.

| File | Portal slot | Spec |
| --- | --- | --- |
| `background.png` | Background | 1024x576 (16:9), PNG, art clustered at the edges so the Grid-view UI can sit in the clear center |
| `cover.png` | Cover Art | 1024x576 (16:9), PNG, title + Goobster dealer art, shown on the Activity Shelf |
| `video-preview.mp4` | Video Preview | 640x360 (16:9), H.264 MP4, ~10s, no audio, under 0.5MB, shown on hover/upsell in the Activity menu |

## Provenance

- `background.png` and `cover.png` are AI-generated in the same style as the
  in-client lobby art (`web/activity/assets/`), then center-cropped and
  scaled to 1024x576.
- `video-preview.mp4` is a real gameplay capture of the Activity running in
  dev mode (`activity.devMode: true`, see `documentation/activity_setup.md`):
  lobby → roulette (seat, chips on red + straight-up 17, spin, win) →
  slots (seat, drop coins, win). Recorded at 1280x720 with a scripted
  browser session, sped up ~2x to fit 10 seconds, and encoded with
  `ffmpeg -vf "setpts=PTS/2.06,scale=640:360,fps=30" -an -c:v libx264 -crf 20 -movflags +faststart`.
