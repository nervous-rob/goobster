---
title: "Portal icons: the glyph registry and the icon languages"
kind: reference
summary: How the web portal draws its room, room-view and Settings-section icons - a registry of named glyphs with the emoji each replaces, six icon languages generated from code (Monoline, Blocks, Sigils, Pixel, Neon, Constellation) that follow the accent, theme and surface live, the `<Icon>` component and its registry-aware wrappers, the per-account Icon style preference (`appearance.iconStyle`, emoji by default) with its live preview and device copy, how negative space matches the surface, and how to add a glyph or a language.
tags: [portal, icons, appearance, web, design, accent]
---

# Portal icons

The portal's navigation used to be drawn entirely with emoji: the sidebar,
the top bar, the Home doors, the Tools cards, the view tabs inside rooms
and the Settings sections. Emoji are free but generic, and they ignore the
accent and the theme. The portal now has its own icons, drawn from code
the way the Goobster berry is ([`scripts/generate-berry-icons.js`](../scripts/generate-berry-icons.js)),
in six **icon languages** a person chooses between in Settings →
Appearance → **Icon style**. Emoji remain the default and the fallback.

## The glyph registry

`apps/web/src/icons/names.ts` names every icon the registries point at and
the emoji it replaces:

| Group | Glyphs |
|---|---|
| Rooms | `home`, `chat`, `knowledge`, `projects`, `discussions`, `people`, `activity`, `tools`, `music`, `trading`, `decks`, `usage`, `settings`, `host`, `docs`, `share` |
| Room views | `notes`, `map`, `compass` (Research, Attention, Initiative), `target` (Plan), `folder` (Files), `puzzle` (Apps), `play` (Runs), `timer` (Automations), `heart` (Friends), `mail` (Messages), `calendar` (Scheduled) |
| Settings and shell | `idcard` (Profile), `mic` (Voice), `palette` (Appearance), `person` (Account, the avatar fallback), `gradcap` (Tutorials), `moon` and `sun` (the theme toggle), `plug`, `code` (GitHub), `notebook` (Notion) |

Three maps join the registries to glyphs: `ROOM_GLYPH` (room id →
glyph), `VIEW_GLYPH` (view id → glyph; a view that reuses a room's emoji
reuses its glyph) and `SECTION_GLYPH` (Settings section id → glyph).
`lib/rooms.cjs` and `settings/sectionMeta.ts` keep their `icon` emoji
untouched, so tests, tutorials and anything else that reads the registry
see what they always saw.

## The languages

Each language is a vocabulary file that draws every glyph. The
`Record<GlyphName, …>` types make a missing glyph a type error, so a
language is always complete.

| Style | File | How it draws |
|---|---|---|
| **Monoline** (`mono`) | `mono.ts` | Rounded 1.75px strokes on the 24px grid, no fills, in `currentColor`: dim at rest, the accent on an active row. |
| **Blocks** (`blocks`) | `blocks.ts` | Three or four primitives (squares, circles, half-discs, triangles) in two tones with negative space. |
| **Sigils** (`sigils`) | `sigils.ts` | Abstract marks rather than pictures: ripples for Spitball, an orbit for the Observatory, voices around a table for the Parlor. |
| **Pixel** (`pixel`) | `pixel.ts` | Two-tone 12×12 bitmaps rendered as crisp rects; sharp at multiples of 12px. |
| **Neon** (`neon`) | `render.ts` | The Monoline paths over a blurred accent copy (an SVG filter); always in the accent. |
| **Constellation** (`constellation`) | `constellation.ts` | Nodes joined by hairlines with one bright star per glyph, as the Observatory and the Knowledge map draw. |

Colours are never literal. `shapes.ts` exports the tokens every language
uses: `A` (the painted accent, `rgb(var(--accent-rgb))`), `A2` (the accent
sunk most of the way into the surface with `color-mix`), `ALITE` (the
accent towards white) and `INK` (negative space, `var(--ic-ink)`). A glyph
therefore recolours live with the accent, the theme and the surface
setting, and the Appearance previews show it before anything is saved.

**Negative space.** A door, the chat dots, a gear's hole are cut in the
surface colour. `--ic-ink` defaults to the page (`--bg`) and the
stylesheet sets it per surface (`#sidebar`, `#topbar`, the settings nav,
cards use `--bg-raise`; doors and pills use `--bg-raise-2`; an active nav
row uses the accent-soft wash). A new surface that shows icons sets
`--ic-ink` to its own background.

## The component

`apps/web/src/icons/Icon.tsx`:

- `<Icon glyph="chat" />` draws a glyph in the painted style. `emoji`
  overrides the fallback emoji; `style` forces a language (the Appearance
  picker renders every language at once this way).
- `<RoomIcon room>`, `<ViewIcon view>`, `<SectionIcon section>` and
  `<ProviderIcon provider emoji>` look the glyph up from the registry maps
  and fall back to the entry's emoji when there is none.
- The markup is generated code from this folder, never user content; it is
  set with `dangerouslySetInnerHTML` on an `aria-hidden` `<svg>`. Filters
  and gradients get an id per instance (`useId`), because two inline SVGs
  sharing an id resolve to the first one in the document.
- The style is read from `html[data-icon-style]` and re-read on the
  `goobster-icon-style-changed` event the paint helper fires.

A glyph is `1.15em` square and sits on the text baseline, so the same
component serves a nav row, a pill, a tools card or a heading by
inheriting the font size around it.

## The setting

Settings → Appearance → **Icon style** (`appearance.iconStyle`: `emoji`
(default), `mono`, `blocks`, `sigils`, `pixel`, `neon`, `constellation`;
anything else is `BAD_ICON_STYLE`) is a card per language showing four
sample glyphs. It previews live, saves with the rest of Appearance, keeps
a device copy (`goobster-icon-style`) that `index.html` paints before the
app mounts, and Reset returns it to emoji. See
[user_settings.md](user_settings.md).

Emoji that are not navigation (status marks in lists, one-off decorations
inside components, the Music Lab's notation) are unchanged; they are not
in the registry and the setting does not touch them.

## Adding a glyph or a language

- **A glyph:** add its name and emoji to `names.ts`, map it in
  `ROOM_GLYPH` / `VIEW_GLYPH` / `SECTION_GLYPH` if a registry entry uses
  it, then draw it in every vocabulary file; the typecheck lists the
  languages still missing it. Keep to the 24 grid, the shape helpers and
  the colour tokens.
- **A language:** add it to `IconStyle` and `ICON_STYLES` in
  `lib/appearance.ts`, `ICON_STYLES` in
  `packages/core/config/userSettingsSchema.js`, the `iconStyle` union in
  `lib/types.ts`, a vocabulary file typed `Record<GlyphName, …>`, a case
  in `render.ts`, a card in the Appearance picker and a row in this table.

`e2e/appearance.spec.js` covers the picker: a live preview swaps the
sidebar's emoji for SVG glyphs, Save persists, a reload paints the saved
style before the app mounts, and every language draws every registry glyph
without falling back to emoji.
