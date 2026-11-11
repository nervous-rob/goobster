# Portal sounds

Settings → Initiative → App sounds controls short UI cues. Goo Pop is the default family; Pocket Wood, Prism, and Orbit are alternatives. The master switch retains the existing `notifySounds` opt-in (off for new accounts). Family, integer volume (0–100), notification cues, interaction cues, and voice-session cues are saved per account through the existing revisioned settings API. Preview buttons play the unsaved family and volume even while muted; Save changes applies them to normal playback.

The original round 2.1 WAV assets live in `apps/web/public/sounds/<family>/`. All 28 files are 48 kHz, 16-bit mono PCM. `apps/web/src/lib/sounds.ts` owns a shared AudioContext, lazy decoding, gain control, interruption, and event deduplication. No external audio service is needed.

| Cue | Trigger |
| --- | --- |
| notification | Mention or new Inbox delivery |
| attention | New Noticed event |
| success | Task or expedition result delivered to Inbox |
| failure | Error toast, failed chat response, or Inbox delivery sourced from the work-failure ledger |
| send | First typing acknowledgement for a submitted chat turn |
| voice-open | Voice engine starts, before the listening loop resumes |
| voice-close | An active voice session ends, after microphone capture stops |

Failure deliveries carry `sourceType` through the existing user-scoped event stream; work failures take priority over the result-kind mapping. Reads, archive updates, initial history, and page refreshes do not trigger completion cues. Stable Inbox and mention IDs prevent repeated playback within the shell session. A short cooldown coalesces event bursts. Active effects are interrupted rather than stacked.

The shell unlocks audio on a user gesture. Hidden tabs remain silent, leaving browser push audio to the device. Routine cues are suppressed during voice sessions and while observed HTML audio/video is playing. Missing assets and autoplay rejection leave the action and visual feedback working. Speech volume, game effects/music, and Music Lab retain their own controls. This is a portal feature; it does not change Discord or operating-system notification audio.

Validation covers preference persistence and atomic rejection, failure event metadata, and browser previews of every asset, saved settings, notification category routing, duplicate events, and master mute.
