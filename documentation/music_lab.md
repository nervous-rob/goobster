---
title: Music Lab and Song Studio
kind: guide
summary: The Conservatory's browser music rooms and the Song Studio arranger — timeline, clips, sections, tracks, the wizard, handoffs, undo, keyboard shortcuts, export/import and recording.
tags: [music-lab, conservatory, studio, portal, audio]
---

# Music Lab and Song Studio

The **Music Lab** (the Conservatory, `/app/conservatory`) is a set of
browser-side music rooms in the portal. Everything in it runs on the
client with Tone.js: no AI key, no server round trip, and no Discord
connection are involved. Rooms save their state to the browser's
`localStorage` under the `goobster.conservatory.*` prefix, so a song is
tied to the browser it was made in — see [Export and import](#export-and-import)
for moving one elsewhere.

This is distinct from Goobster's Discord music playback (`/play`,
`/spotdl`, voice channels), which is documented in `music_system.md`.

## Rooms

| Room | Path | What it is for |
| --- | --- | --- |
| Home | `/conservatory` | Orientation and the door into every room |
| Intervals | `/conservatory/intervals` | Hear and drill intervals |
| Chords | `/conservatory/chords` | Chord Workbench: diatonic harmony and progressions |
| Rhythm | `/conservatory/rhythm` | The Rhythm Engine: grooves, feel, drum grids |
| Harmony | `/conservatory/harmony` | The Harmony Engine: chord organisms in a gravity field, the chord foundry |
| Space | `/conservatory/space` | Harmonic Space: a 3-D constellation of keys, modes and intervals |
| Melody | `/conservatory/melody` | The Melody Engine: breed single-note creatures for the Stage |
| Stage | `/conservatory/stage` | The Ensemble Stage: a looping band of "creatures" |
| Studio | `/conservatory/studio` | The **Song Studio**: arrange creatures into a full song |

Rooms hand material to each other. The Rhythm and Harmony rooms can
*send to Stage* (a groove or a chord lane) and *send to Studio* (see
[Handoffs](#handoffs)). Creatures you save on the Stage appear in the
Studio's creature library and in the wizard.

## The Song Studio

The Studio is an arranger: one timeline, a strip of **sections**, a set
of **tracks**, and **clips** that decide which track plays over which
bars. Where the Stage loops one phrase, the Studio walks an absolute
measure timeline from bar 1 to the end.

### Songs

The **Song** settings inspector holds the song's name, **Key** (seeds the
chords of new sections and anchors written leads — forged chords are not
transposed), **Meter** (time signature and beat grouping), automatic
**Drum fills**, and the master bus (level and reverb send).

The **Song** selector at the top of the toolbar switches between the
songs stored in this browser. Alongside it:

- **Wizard** — builds a song in four steps: *Structure* (a template or a
  genre-library band, key, section plan), *Feel* (tempo, swing, groove),
  *Fill the parts* (which creature plays each part), *Review*.
- **+ Blank** — an empty song in the current key with no sections.
- **Duplicate** — copies the current song. Copies are numbered — *Song (copy)*,
  *Song (copy 2)* — never *Song (copy) (copy)*; the same rule names
  duplicated tracks.
- **Export** / **Import** — a portable `.json` file, see below.
- **Delete** — two-step: the button arms and reads *Really delete?* for
  four seconds; a second click deletes the song and its undo history.

### Sections

The section strip above the lanes divides the song into blocks. Each
section has a kind (`intro`, `verse`, `prechorus`, `chorus`, `bridge`,
`outro`, `custom`), a name, a length in bars (1–16), a chord list (up to
8 chords built with the foundry settings) and a *measures per chord*
value. Click a block in the ruler to open it in the **Section** inspector;
**+ Add section** appends one. Sections chain end to end, so lengthening
one shifts everything after it.

**Drag a block left or right to reorder the song** (mouse or pen; on touch
the timeline keeps scrolling and the inspector's *← Move* / *Move →*
buttons do the same). An amber marker shows where the section will land.
The clips that play inside a section travel with it, so moving the chorus
moves what plays during the chorus: clips that cross a section boundary
are split there and joined back together wherever the pieces land next to
each other again. *Duplicate* (also `Ctrl+D`) inserts a numbered copy
right after the original with the same clips; *Copy* / *Paste after*
carry a section and its clips through the clipboard, including into
another song (pieces on tracks the other song lacks are dropped).

### Tracks and clips

Each track is one performer with a role (`kick`, `snare`, `hihat`,
`chords`, `bass`, `melody`), a **M**ute, **S**olo, level fader and a
creature. Click the track name to select it (the whole row highlights) and
open it in the **Track** inspector:

- **Name**, **Level** (dB, mirrored by the header fader) and **Pan**
  (`L100`…`C`…`R100`; double-click the slider to re-centre) for every
  track. Drum roles share one bus each and stay centred, so their pan
  slider is locked.
- Drum tracks: the **step pattern** for one bar (highlighted steps fall on
  the beat), with **Clear**, **Reset pattern** (the role's default for the
  current meter) and **Every beat** shortcuts. The pattern repeats every
  bar wherever the track has a clip.
- Tonal tracks: **Voice**, and either the **Contour** loop and register,
  the written-lead melody editor, or the chord track's voicing / register
  overrides.

While any track is soloed, every other track's clips dim to show they are
silent. `M` and `S` toggle mute and solo on the selected track.

**+ Add track** (the button under the track headers) opens the *Add a
track* panel with three ways to add a performer:

- **Core roles** — `+ kick`, `+ snare`, `+ hihat`, `+ chords`, `+ bass`,
  `+ lead`, and `+ written lead` (a lead with the piano-roll melody
  editor). These start on the role's default voice.
- **Your voices** — every voice saved in the Voice Builder (on the Melody
  or Harmony Engine), each with `+ lead`, `+ bass` and `+ chords` buttons
  that add a track of that role already playing the voice. The track is
  named after the voice.
- **Creature library** — creatures saved on the Stage or bred in the
  Melody Engine; **Hire** adds a lead or bass track carrying the
  creature's voice, contour and register.

A new track gets one clip across the whole song. Any track's voice can be
changed afterwards in the Track inspector's **Voice** menu, which lists
the core presets followed by your saved voices.

Clips gate the track: a performer is audible only inside its clips.

- Double-click empty lane space to drop a one-bar clip; drag on empty
  space to paint a longer one.
- Drag a clip to move it; drag its right edge to resize.
- Click a clip to select it (this also selects its track).
- **Split at bar N** in the Track inspector cuts the selected clip where
  the playhead sits (the button is disabled unless the playhead is
  strictly inside the clip).
- **Copy** / `Ctrl+C`, `Ctrl+X` and **Paste** / `Ctrl+V`: a copied clip
  pastes onto the selected track at the playhead (the Track inspector
  shows a *Paste at bar N* button while a clip is on the clipboard), or at
  a right-clicked bar. **Duplicate** / `Ctrl+D` drops a copy directly
  after the clip; if the song ends there a notice says so.
- **Delete clip** in the inspector or the `Delete` / `Backspace` key
  removes the selected clip; `←` / `→` nudge it one bar, stopping at the
  ends of the song.
- **Move track up / down** and **Duplicate track** (clones the performer
  and its clips) live in the Track inspector header.

The clipboard is in memory for the session: it survives switching songs
but not a reload, and it never touches the system clipboard.

Drum roles share one synth each. Two kick tracks that hit the same step
sound once and both light up.

### Right-click menus

Every part of the timeline has a context menu (`Escape`, a click
elsewhere, or scrolling closes it; arrow keys move, `Enter` activates):

| Target | Actions |
| --- | --- |
| Clip | Copy, Cut, Duplicate after, Split at the clicked bar, Fit to the section under the cursor, Play from clip start, Delete |
| Empty lane | Paste clip at the clicked bar, New 1-bar clip here, Clip across the section under the cursor, Clip across the whole song, Play from here |
| Track header | Mute / Solo, Move up / down, Duplicate track, Paste clip at playhead, Delete track |
| Section block | Copy, Cut, Paste section after, Duplicate, Add empty section after, Move left / right, Loop this section, Play from here, Delete |

### Transport

The transport bar has play/pause, stop, record, the groove picker, BPM
(type a number, then `Enter` or leave the field to commit; it is clamped
to 40–200), swing, a loop toggle, a metronome **Click**, and the position
readout: current `bar.beat / total bars`, plus an elapsed / total clock
(`m:ss`). The status pill in the header reads *Audio off · press Play*
until the first play gesture wakes the browser's audio, then *Audio
ready*, *Playing* or *Recording*.

- **Click** — a metronome on every beat, accented on the downbeat. It is
  wired past the master bus, so it is never in a recording. The setting
  is remembered per browser.
- **Loop region** — *Whole song* or the selected *Section*.
- **Zoom** — pixels per bar: the slider, `−` / `+` buttons (also the `-`
  and `+` keys), and **Fit**, which picks the zoom that shows the whole
  song in the visible lane area and scrolls back to bar 1.
- **Follow** — when on, the timeline pages horizontally so the playhead
  stays in view during playback and after a seek. Turn it off to pan
  freely while the song plays.
- Click a bar number in the ruler to seek there, live or stopped.

### Undo and redo

Every project edit (sections, tracks, clips, settings, sliders) is
recorded. Slider gestures that arrive within 600 ms of each other collapse
into one step, so dragging a volume fader is one undo. The history keeps
the last 100 states per song and lives in memory for the session.

### Keyboard shortcuts

Shortcuts are inactive while a text field has focus or the wizard is open.

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `Home` | Stop and rewind to the loop region start |
| `Delete` / `Backspace` | Remove the selected clip |
| `←` / `→` | Nudge the selected clip one bar |
| `L` | Toggle loop |
| `M` / `S` | Mute / solo the selected track |
| `+` / `-` | Zoom in / out |
| `Ctrl`/`Cmd` + `Z` | Undo |
| `Ctrl`/`Cmd` + `Shift` + `Z`, `Ctrl` + `Y` | Redo |
| `Ctrl`/`Cmd` + `C` / `X` | Copy / cut the selected clip (else the selected section) |
| `Ctrl`/`Cmd` + `V` | Paste: a clip at the playhead on the selected track, a section after the selected one |
| `Ctrl`/`Cmd` + `D` | Duplicate the selected clip (else section) right after itself |

### Handoffs

The Rhythm Engine's **Set the Studio song →** and the Harmony Engine's
**Studio section →** each queue one payload — a groove (`bpm`, `swing`,
`rhythmId`) or a named chord list in a key — and open the Studio, which
applies it to the current song and shows a notice: a groove sets tempo,
swing and the rhythm pattern; chords are appended as a new verse section
sized to hold them. If no song exists yet the Studio creates *Song 1*
first so the handoff is never dropped.

### Recording

The record button captures the master bus while the song plays. Stopping
downloads `<song name>.wav` (decoded and re-encoded client-side; if that
fails the browser's native `webm` recording is downloaded instead).

### Export and import

**Export** downloads `<song name>.json`:

```json
{
  "format": "goobster-studio-song",
  "version": 1,
  "exportedAt": "2026-09-26T12:00:00.000Z",
  "project": { "name": "Pop Anthem in C", "bpm": 118, "sections": [], "tracks": [], "clips": [] }
}
```

**Import** accepts that envelope (or a bare project object). The file is
treated as untrusted: names are trimmed and capped, numbers are clamped
to the studio's ranges (BPM 40–200, swing 0–0.5, section length 1–16
bars, at most 8 chords per section, volume −24–0 dB, reverb 0–0.6), chord
settings fall back to defaults when unknown, a track `pan` outside −1…1 is
clamped (a non-numeric one is dropped), clips whose track is missing
are dropped and the rest are clamped to the song, duplicate section and
track ids are re-issued, and the imported song always gets a fresh id so
it never overwrites an existing one. Files with a newer `version` or
without sections and tracks are refused with a notice.

### Storage keys

All keys are under the `goobster.conservatory.` prefix in `localStorage`.

| Key | Contents |
| --- | --- |
| `studioProjects` | Every song in this browser |
| `studioCurrentProjectId` | The song the Studio opens to |
| `studioZoom` | Pixels per bar |
| `studioLoop` | Loop toggle |
| `studioFollow` | Follow-playhead toggle |
| `studioClick` | Metronome click toggle |
| `studioHandoff` | A pending handoff from another room (consumed on open) |
| `creatureLibrary` | Saved creatures shared with the Stage |
| `customVoices` | Voices built in the Voice Builder (sample audio lives in IndexedDB) |

Clearing site data removes all of them; export songs you care about first.

## For developers

The Studio lives in `apps/web/src/music-lab/components/studio/`
(`StudioEngine.tsx` is the room, `SongTimeline.tsx` the lanes,
`StudioTransport.tsx` the bar, `SongWizard.tsx` the builder). Playback is
`hooks/useSongOrchestrator.ts`, which drives `Tone.Transport` with an
internal step counter over the flattened song (`lib/songTheory.ts`).

Pure, unit-tested helpers sit in `lib/songEdit.cjs` with a typed façade in
`lib/songEdit.ts`: undo history (`createHistory`, `recordHistory`,
`undoHistory`, `redoHistory`), clip surgery (`splitClipAt`,
`mergeAdjacentClips`, `pasteClip`, `duplicateClip`), section structure
(`sectionSpans`, `reorderSections`, `duplicateSection`,
`copySectionPayload`, `pasteSection` — all of which cut clips into
per-section pieces, re-lay them under the new order and heal the seams),
track operations (`moveTrack`, `duplicateTrack`),
naming (`copyName`), clock math (`songDurationSeconds`, `elapsedSeconds`,
`formatClock`) and
the file format (`serializeSongProject`, `parseSongProjectFile`,
`songFileName`). Tests are in `tests/studioSongEdit.test.js` (CI group
`portal`). Layout shares the `--st-head-w` CSS variable between the track
header column, the lane width and the playhead so they stay aligned at
every breakpoint. `ContextMenu.tsx` is the shared right-click menu;
`StudioEngine` builds the item list per target (`StudioMenuTarget` in
`SongTimeline.tsx`), and `SectionStrip.tsx` owns the pointer-based section
drag.
