# The installed app (PWA)

The portal at `/app` is a Progressive Web App: it can be installed from the
browser onto a phone, a tablet or a desktop, opens in its own window, keeps
working for reading when the connection drops, shows an unread badge on its
icon, receives shared content from other apps, and - when a device opts in -
notifies the person even when no tab is open. Everything here is an
enhancement on top of the normal browser portal: a browser without one of
these APIs simply does not show the affordance.

Nothing in this document is a new place for personal data except the
**push subscriptions** table, which is covered by the privacy paths (below).

## What the person gets

| Capability | Where | How it works |
|---|---|---|
| Install | *Install app* in the sidebar footer (or the top bar's account menu), a one-time shell banner, and Settings → Appearance → *Install Goobster as an app* | Every entry does the same thing: with a captured Chromium prompt the click installs on the spot; otherwise it leads to the Settings card, where iOS gets *Share → Add to Home Screen* and other browsers the menu instructions. The banner appears only where a one-tap install exists (prompt captured, or iOS Safari), *Not now* snoozes it for 30 days on that device, and every entry disappears once the app is installed or running as the app. |
| Shortcuts | Long-press / right-click the app icon | `manifest.webmanifest` `shortcuts`: New chat, Inbox, Projects, Discussions - canonical room paths from `apps/web/src/lib/rooms.cjs`. |
| Own window | Installed app | `display: standalone` with `display_override: [window-controls-overlay, standalone]`; `launch_handler.client_mode: navigate-existing` so a second launch (or a shortcut) reuses the open window instead of stacking a new one. |
| Unread badge | App icon | `navigator.setAppBadge` with the same number the sidebar shows (Inbox unread + direct-message unread + pending friend requests); cleared on sign-out. |
| Offline | Any room | Rooms already opened stay readable (TanStack Query `networkMode: 'offlineFirst'` serves the cache); a banner says so; Send is disabled and the draft stays; a cold navigation while offline gets the precached `offline.html`, which reloads itself when the connection returns. |
| Updates | Shell banner | When a new build's worker is waiting, *Goobster was updated - Reload* appears; Reload hands over to the new worker and refreshes. A tab that stays open for days checks for an update every time it becomes visible. |
| Stale chunks | Transparent | A lazily loaded room whose hashed chunk vanished with a deploy is answered from the worker's cache; failing that, the page reloads once (never a loop) and otherwise shows *Reload* instead of a blank stage. |
| Share into a chat | The OS share sheet | `share_target`: shared text/URLs land in the composer and shared files on the attachment strip of a new chat. |
| Browser notifications | Settings → Initiative → *Browser notifications* | Per device. New Inbox items, mentions in shared discussions and direct messages reach the device with no tab open. Only a title and a portal path are sent - never the text. |

## Architecture

### Manifest and metas

`apps/web/public/manifest.webmanifest` is served verbatim at
`/app/manifest.webmanifest`. It carries `id`, `lang`, `dir`, `categories`,
`display_override`, `launch_handler`, `shortcuts`, `screenshots` (one
`wide`, one `narrow`, under `apps/web/public/screenshots/` - real captures
of the portal, sizes verified by the `webClientServing` spec) and
`share_target`. `apps/web/index.html` adds `color-scheme`,
`mobile-web-app-capable` and the `apple-mobile-web-app-*` metas.

`apple-mobile-web-app-status-bar-style: black-translucent` together with
`viewport-fit=cover` makes the installed app on iOS draw **under** the
status bar, so the page starts behind the clock and
`env(safe-area-inset-top)` becomes the height of that strip (0 in a
browser tab and on every other platform). The stylesheet pays that inset
**once, in the shell** (`apps/web/src/styles.css`, *the top safe area*):
in the sidebar layout `#stage` steps down by it - the offline / update /
paused banners, every room header and every pane follow - and `#sidebar`
pads by it; in the top-bar layout `#topbar` carries it. Fixed drawers that
sit at the top of the viewport (`#sidebar` on a phone,
`.conversations-panel`) and full-screen overlays pad by it themselves. A
room header must **not** add `env(safe-area-inset-top)`: it would double
the gap in every room and, where forgotten, put the ☰ and the title under
the clock (the Home toolbar did exactly that when the metas landed).

### Hosting rules (`packages/core/web/routes/eventsStatic.js`)

- `/app/sw.js` is served with `Cache-Control: no-cache` and the token
  `__GOOBSTER_BUILD__` replaced by the first twelve hex characters of the
  SHA-256 of `apps/web/dist/index.html`. The worker names its cache
  `goobster-app-<stamp>`, so a new build activates a new worker whose
  `activate` step drops the previous build's cache. **Nobody bumps a
  version constant any more.**
- `/app/assets/*` (Vite's content-hashed chunks) is `immutable, max-age=1y`.
- Everything else under `/app` - `index.html` for every SPA route, the
  manifest, icons, the stable `style.css`, `offline.html` - is `no-cache`
  (revalidate every load).
- `POST /app/share-target` answers `303 /app/chat`. It only ever runs when
  the worker is not in control (first visit, cleared storage); with the
  worker installed the POST never reaches the server.

### The service worker (`apps/web/public/sw.js`)

- Never touches `/api/*`; share pages (`/app/share/*`,
  `/app/observatory/share/*`) and `/app/sw.js` itself stay live-only.
- **Documents are never cached.** `index.html` points at hashed chunks
  that vanish on the next build, so a cached shell is an unstyled page. A
  navigation that fails offline is answered with the precached
  `offline.html`.
- `/app/assets/*` is cache-first (the name is the version). Everything
  else under `/app/` is network-first; the cache answers offline **and
  answers a `404`** so a tab built against the previous deploy can still
  fetch the chunk it needs.
- `message { type: 'SKIP_WAITING' }` → `skipWaiting()`; the page reloads
  on `controllerchange` once the person accepted the update.
- `push` shows a notification with `title`, `body`, `tag` and a portal
  path in `data.link` - **skipped when a portal window is visible**, because
  the in-app notice already covers that case (test pushes always show).
  `notificationclick` focuses an open portal window and posts
  `{ type: 'goobster:navigate', path }` to it (the router navigates without
  a reload), or opens a new window on the path.
- `pushsubscriptionchange` re-subscribes with the same server key and
  `POST`s the new subscription with the session cookie.
- `POST /app/share-target` (in scope) parks the form's `title`/`text`/`url`
  and `files` in the `goobster-share-target` cache and redirects to
  `/app/chat?shared=1`. The Study consumes it exactly once
  (`apps/web/src/lib/shareTarget.ts`), then deletes the cache and drops
  the query flag.

### Client plumbing (`apps/web/src/lib/pwa.ts`, `notifications.ts`)

`main.tsx` calls `captureInstallPrompt()` (keeps `beforeinstallprompt`
for the install entries - `components/InstallEntry.tsx` renders the nav
button and the shell banner, `components/InstallPrompt.tsx` the Settings
card; `useInstallPrompt()` is the one source of truth for *available /
installed / standalone / nudge*), `installChunkRecovery()` (Vite's `vite:preloadError`) and
`registerServiceWorker()` (tracks `updatefound` → waiting worker →
`SW_UPDATE_EVENT`, and forwards worker `goobster:navigate` messages), and
wraps the router in `ChunkErrorBoundary`. The shell (`AppShell.tsx`) owns
the badge, the offline and update banners, and worker navigation.

Local notifications: when the tab is **hidden** and the person allowed
notifications, `showLocalNotification` raises the same Inbox / mention
notice through the worker (`registration.showNotification`). It steps
aside when this browser holds a push subscription - the push carries the
same `tag`, so nothing shows twice.

## Web Push

### Configuration

Web Push needs a VAPID key pair (RFC 8292). Resolution order in
`packages/core/config/pushConfig.js`:

1. `GOOBSTER_VAPID_PUBLIC_KEY` + `GOOBSTER_VAPID_PRIVATE_KEY` (+ optional
   `GOOBSTER_VAPID_SUBJECT`) in the environment;
2. `webapp.push.vapidPublicKey` / `vapidPrivateKey` / `subject` in
   `config.json`;
3. otherwise a pair is **generated on first use and kept in
   `data/web-push-keys.json`** (mode `0600`, included in `npm run backup`
   as the `web-push-keys` file set). The lite deployment therefore needs
   no configuration.

`GOOBSTER_WEB_PUSH_ENABLED=0` / `webapp.push.enabled: false` turns the
feature off. Half a pair, or no writable `data/`, disables it with a
reason (`half-configured`, `no-keys`) that Settings shows instead of a
button. **The full (split) deployment must give the bot and api processes
the same pair** through env or config - each process resolving its own
generated pair would strand the other's subscriptions. The default subject
is `webapp.publicUrl` when it is `https://`, else `mailto:goobster@localhost`;
set a real contact for production.

Deleting the key file invalidates every subscription; devices re-enrol
from Settings.

### Storage and routes

`push_subscriptions` (`userId`, `endpoint` UNIQUE, `p256dh`, `auth`,
`userAgent`, `createdAt`, `lastSeenAt`, `lastSentAt`, `failCount`). The
endpoint is a capability to reach one device; it is **never returned to
any client** - the pane asks "is *this* endpoint mine?" and gets a boolean.
A person keeps at most 8 devices (oldest unseen pruned). Re-subscribing
the same endpoint updates the row; another account signing in on the same
browser takes the device over.

| Route | Purpose |
|---|---|
| `GET /api/app/push?endpoint=` | `{ enabled, reason, publicKey, devices, thisDevice }` |
| `POST /api/app/push/subscriptions` | `{ subscription }` (the browser's `PushSubscription.toJSON()`) |
| `DELETE /api/app/push/subscriptions` | `{ endpoint }` or `{ all: true }` |
| `POST /api/app/push/test` | A test push to the caller's devices (5/min) |

### Delivery

`packages/core/services/pushService.js` is never called by producers
directly. The **Inbox is the record**: `inboxService.deliver()` echoes
every *newly created* item as a push that points at the row (`title`,
kind label, `link`, `tag: inbox-<id>`), exactly as it echoes to Discord -
bookkeeping around the item, not the item. Mentions in shared discussions
(`parlorService`) and direct messages (`directMessageService`) call
`notifyMention` / `notifyDirectMessage` with identity hints only (who,
where). Nothing ever puts a message body, a token or an address in a
payload.

Failures never break delivery. `404`/`410` from the push service prunes
the device; any other error increments `failCount` (dropped at 5) and
writes a `work_failures` row (`kind: delivery`, `phase: web_push`,
`code: PUSH_FAILED`, `reason: HTTP <status>`) keyed on the Inbox item -
never the payload or the endpoint (documentation/work_ledger.md).

### Privacy

`/forget-me` deletes `push_subscriptions` (`counts.pushSubscriptions`),
`auditUser` counts the table, and the transparency report carries
`pushDevices` (a count, never endpoints). Push payloads contain no
personal content, so there is nothing to erase on the device side beyond
the notification the OS already showed.

## Testing

- `tests/pushService.test.js` (CI group `web`, both engines): subscribe /
  update / take-over / cap / unsubscribe, the disabled state, the Inbox
  echo (content never in the payload, dedupe = one push), prune on 410,
  fail counting + ledger rows without content, mentions and DMs, the
  privacy paths, and the routes through a real Express app with a fake
  sender.
- `tests/webClientServing.test.js`: `sw.js` stamped and `no-cache`,
  immutable assets, `no-cache` documents, the share-target fallback, the
  manifest's completeness (shortcuts on canonical rooms, screenshots
  present and sized as declared), and the worker's contract.
- `e2e/pwa.spec.js` (Playwright): the worker takes control, offline
  banner + disabled Send + the offline page on a cold navigation, a
  share-target `POST` landing in the composer with the file attached, the
  badge equalling the sidebar count, and the Settings round-trip
  (subscribe → `thisDevice` → unsubscribe) with a fake `PushManager`.

Manually: Chrome → *Application* → *Manifest* lists the shortcuts and
screenshots and offers *Install*; *Service workers* → *Offline* then reload
shows `offline.html`; DevTools → *Push* on the worker shows a notification
whose click opens the Inbox.
