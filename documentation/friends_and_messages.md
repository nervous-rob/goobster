---
title: "Friends and direct messages"
kind: reference
summary: Goobster's own friendship graph and one-to-one messaging - how a person finds someone (name, verified email, shared Discord server, pasted id), the friend-request lifecycle (one canonical friendships row per pair, Inbox delivery with a Discord DM echo carrying Accept / Decline buttons, auto-accept of a mutual request, decline cooldown), what being friends unlocks (portal presence, direct messages, the invite pickers), the dm_threads / dm_messages model and its read state, the People room (Friends and Messages views) and its badge, the HTTP routes, rate limits, live updates, and the erasure path. Replaces the Activity-synced Discord friend roster (user_friends), which never worked without the Social SDK scope.
tags: [friends, direct-messages, people, inbox, presence, privacy, portal, web]
---

# Friends and direct messages

Goobster keeps **its own** record of who is friends with whom. A person
finds someone, sends a friend request, the request lands in the other
person's Inbox (and, when they can receive one, their Discord DMs with
Accept / Decline buttons), and once accepted the pair see each other's
portal presence and can message each other in the **People** room.

This replaces the Discord friend roster the Parlor drawer used to show.
That roster depended on the Embedded App SDK's `relationships.read`
scope inside the Activity - a bot token cannot read a friend list at all -
so on every installation without the Activity, the Social SDK terms and
the opt-in flag, the component read *"None synced yet"* forever. Nothing
here is a cache of Discord state; the friendship is Goobster's record and
works identically with the Discord adapter off.

The one-sentence version: **a friendship is a mutual, explicit, revocable
consent between two people, and everything it unlocks (presence, messages,
appearing in each other's pickers) is gated on it.**

## Services

| Service | Owns |
|---|---|
| `packages/core/services/friendService.js` | People search, the request lifecycle, the friend list with presence, Inbox / Discord delivery, the Discord buttons, `listInvitable` for the project and discussion pickers, erasure. Errors are `FriendError` (`status`, `code`). |
| `packages/core/services/directMessageService.js` | Threads, messages, read state, unread counts, erasure. Errors are `DirectMessageError`. |
| `packages/core/web/routes/people.js` | The HTTP surface (below). |
| `apps/web/src/rooms/PeopleRoom.tsx` | The People room: Friends and Messages views. |

## Tables

All in `packages/core/db/schema.sql`; ids are principal ids stored as
TEXT (a Discord snowflake or a native `usr_…` id), timestamps UTC text.

- **`friendships`** - one row per **pair**, keyed `(lowId, highId)` (the
  two ids sorted, `UNIQUE`), with `requesterId` / `addresseeId` recording
  who asked, `status` in `pending | accepted | declined | cancelled |
  removed`, `createdAt`, `respondedAt`, `updatedAt`. There is never a
  second row for the same pair: a new request after a decline, a
  cancellation or an unfriending **reopens** the same row as `pending`
  with a fresh `createdAt`.
- **`dm_threads`** - one thread per pair (`lowId`, `highId`, `UNIQUE`),
  `lastMessageAt`, `lastMessageId`.
- **`dm_participants`** - `(threadId, userId)` with `lastReadMessageId`;
  the per-seat read cursor.
- **`dm_messages`** - `threadId`, `senderId`, `content`, `createdAt`.

`user_friends` (the old roster cache) is dropped by the schema on the
next open.

## Finding someone

`friendService.search({ userId, q, gateway })` - `GET /api/app/friends/search?q=`
- returns `{ people, kind }` where `kind` says how the query was read:

| Query looks like | `kind` | What matches |
|---|---|---|
| an email address | `email` | The account whose **verified** `account_emails` row has exactly that normalized address (`mailService.normalizeEmail`). The address is a **key, not a result**: nothing ever displays another person's email, and an unverified or unknown address simply matches nobody, so the search cannot be used to test whether an address is registered beyond "this person is findable". |
| a principal id (snowflake or `usr_…`) | `id` | That principal; for a snowflake the bot has never seen as a principal, the Discord user through the gateway (`getUser`), who becomes a principal when the request is sent. |
| two or more characters | `name` | Members of this installation whose latest portal name, display name or login name **starts with** the query (active accounts; with `identity.requireAccount` off, anyone who has signed in to the portal), plus members of Discord servers the caller shares with Goobster (`listMutualGuilds` + `searchGuildMembers`, bounded). |
| anything shorter | `none` | Nothing - the roster is never browsable. |

Each result is `{ id, name, avatar, source, via, relationship }`:
`source` is `member` (of the installation, `via` the installation name),
`server` (`via` the server name) or `friend`; `relationship` is the
caller's standing with that person - `none`, `friends`, `outgoing`
(a request they sent, awaiting an answer) or `incoming` (a request
waiting for *them*) with the `requestId` - so the client renders the
right action without a second call. The caller, bots and the assistant
identity are never results. An unreachable bot skips the server source;
the search still answers from the installation's members.

## The request lifecycle

`friendService.request({ userId, targetId, gateway })` -
`POST /api/app/friends/requests { userId }`:

1. Validates both ids (`BAD_USER_ID`), refuses self (`CANNOT_FRIEND_SELF`)
   and the assistant (`CANNOT_FRIEND_BOT`), rate-limits the requester
   (`RATE_LIMITED`, 20 requests per hour, `slidingWindowLimit` scope
   `friend_request`).
2. Makes sure the target is a principal (`_ensureTargetPrincipal`): a
   snowflake the bot can see gets a legacy principal row; an id nobody
   knows is `NO_SUCH_USER`; a snowflake with the bot unreachable is
   `BOT_OFFLINE` (retry later, never a permanent failure).
3. Looks at the pair's row:
   - `accepted` → `ALREADY_FRIENDS`;
   - `pending` from me → `ALREADY_REQUESTED`;
   - `pending` from **them** → both wanted this: the row is accepted at
     once and the reply is `status: 'accepted'` (the other person is told
     in their Inbox like any acceptance);
   - `declined` inside the last **24 hours** → `REQUEST_COOLDOWN`: a
     person who said no is not asked twice in a row;
   - `declined` (older), `cancelled`, `removed` → reopened as `pending`;
   - no row → inserted as `pending`.
4. Delivers the request through **`inboxService.deliver`** (kind `invite`,
   title *"<name> wants to be friends"*, `source { type: 'friend_request',
   id }`, `link '/people/friends'`, `dedupeKey friend_request:<id>:<createdAt>`)
   - the Inbox row is the record; the Discord DM is the echo. The DM is an
   embed with **Accept** / **Decline** buttons (`accept_friendreq_<id>` /
   `decline_friendreq_<id>`), routed by `apps/bot/events/interactionCreate.js`
   to `friendService.handleButton`, state in the database so a restart
   never orphans a button. A failed DM is `dmSent: false`, never an error.

Answering - `respond({ userId, requestId, accept })`,
`POST /api/app/friends/requests/:id/accept|decline`, or the buttons -
requires the caller to be the **addressee** of a **pending** row
(`NO_SUCH_REQUEST`, `REQUEST_SETTLED`). Accepting checks the friend cap
(`TOO_MANY_FRIENDS`, 1000) and tells the requester in their Inbox (kind
`system`, *"<name> accepted your friend request"*). **Declining is
silent** - the requester sees the request leave their *Sent* list and
nothing else, and the 24-hour cooldown starts.

The requester can withdraw a pending request (`cancel`,
`DELETE /api/app/friends/requests/:id`); either friend can end the
friendship (`remove`, `DELETE /api/app/friends/:friendId`,
`NOT_FRIENDS` when there is nothing to end). Both are silent.

The Inbox presents a friend request as its own payload
(`item.friend = { id, status, requesterId, requesterName, requesterAvatar,
addresseeId, addresseeName, actionable, respondedAt }`,
`inboxService._presentFriend`), so the Inbox row itself carries Accept /
Decline while the request is pending and states the outcome afterwards -
the same pattern as an access request.

## What friends can do

- **See each other's presence.** `listFriends(userId, { presence: true })`
  decorates each friend with `online` from `presenceService.onlineIds`
  (derived from `web_sessions.lastSeenAt`, respecting the hide-presence
  setting). Nobody who is not your friend learns whether you are online;
  the sidebar's **Friends online** menu (`shell/ActiveFriends.tsx`), the
  Friends view and the Discussions drawer all read the same list.
- **Message each other** (below).
- **Appear first in each other's invite pickers.** `listInvitable` (the
  project and discussion People pickers, `GET /api/app/people?q=`) lists
  friends first, then shared-server mates, then installation members for a
  query, and reports `hasFriends` so the picker can point at the People
  room when the list is empty. Inviting was never gated on friendship and
  still is not - a pasted id always works.

## Direct messages

Direct messages are their own thing, not a Chat conversation and not a
Discussion. A Chat is a person talking to Goobster (provider turns,
memory, tools); a Discussion is a shared table with personas and an
owner; a DM is two humans talking, no model in the loop, no persona, no
owner. They share the portal's presentation (the `chat-log` / `msg` /
`composer` classes), the SSE event stream and the presence layer, but
none of the chat pipeline.

- `openWith({ userId, friendId })` - `POST /api/app/dm/threads { userId }`
  - returns the pair's thread, creating it (and both `dm_participants`
  seats, in one transaction) on first use. **Only friends can open a
  thread** (`NOT_FRIENDS`, 403).
- `send({ userId, threadId, content })` -
  `POST /api/app/dm/threads/:id/messages { content }` - requires the
  pair to *still* be friends, trims, refuses empty (`EMPTY_MESSAGE`) and
  over-long (`MESSAGE_TOO_LONG`, 4000 characters) text, rate-limits the
  sender (`RATE_LIMITED`, 60 messages per minute, scope `dm_send`), and in
  one transaction inserts the message, bumps the thread's `lastMessageAt`
  / `lastMessageId` and moves the sender's read cursor past it.
- `getMessages({ userId, threadId, limit, beforeId })` -
  `GET /api/app/dm/threads/:id?limit=&beforeId=` - a page of messages,
  oldest first, `hasMore` for the older page (`BAD_CURSOR` for a bad id).
- `markRead({ userId, threadId, upToId })` - `POST …/read` - moves the
  caller's cursor forward only.
- `listThreads({ userId })` - `GET /api/app/dm/threads` - the caller's
  threads, most recent first, each with `with { id, name, avatar, online }`,
  `friends` (whether the pair is still friends), `unread` and the last
  message; plus the total `unread`.

**Unfriending does not delete the conversation.** The thread stays
listed and readable for both people (it is their history) but turns
read-only - `send` and `openWith` refuse with `NOT_FRIENDS` and the client
shows a notice instead of the composer. Becoming friends again reopens
the same thread.

Only the two participants can read or write a thread; a stranger's
`threadId` is `NO_SUCH_THREAD` (404), never a permission hint.

## Live updates and counts

- `eventBusService.publish('friends', { userId })` fires on every state
  change for both people; the SSE stream (`/api/app/events`) invalidates
  the `friends` and `me` queries.
- `publish('dm-message', { userId, invalidate: ['dm-threads', 'dm-thread:<id>', 'me'] })`
  fires to both seats on a send, so an open thread updates without a
  poll.
- `GET /api/app/me` carries `people: { pending, unread }` - incoming
  friend requests awaiting the caller plus unread direct messages. The
  People entry in the sidebar / top bar shows that sum
  (`roomBadgeCount` in `apps/web/src/lib/rooms.ts`); Activity's badge
  stays the Inbox unread count alone.

## The People room

`/people` is the eighth primary destination
([portal_navigation.md](portal_navigation.md)), with two registered
views:

| View | Path | Shows |
|---|---|---|
| Friends | `/people/friends` | **Find someone** (name, email or id; results carry the right action: Add friend, Accept, Sent, Friends), requests **waiting for your answer**, requests you **sent** (withdraw), and **your friends** with a presence dot, **Message** and **Unfriend**. |
| Messages | `/people/messages`, `/people/messages/:threadId` | The thread list with unread counts, and the open thread: history, autoscroll, Enter to send, the read-only notice after an unfriending. |

The Discussions drawer's **Friends** section and the sidebar's **Friends
online** menu are views onto the same list and link to the People room.
The People picker for projects and discussions points there too when you
have no friends yet.

`appearance.startPage` accepts `people`.

## Privacy

Friendships and messages are per-person data on both sides:

- `/forget-me` (`privacyService.forgetUser`) deletes every `friendships`
  row the person is on (both directions - their friends lose them too)
  and, through `directMessageService.forgetUser`, **every DM thread they
  sat in**, including the other person's messages in it. A two-person
  conversation cannot be kept whole with one person erased, and
  half-conversations are worse than none; the other person is not
  notified.
- `auditUser` counts `friendships`, `dm_threads` and
  `dm_messages_authored`; the transparency report shows
  `friends { friends, incomingRequests, outgoingRequests }` and
  `directMessages { threads, sent }`.
- `identityService.OWNER_COLUMNS` lists `friendships.requesterId`,
  `friendships.addresseeId` and `dm_messages.senderId` for the identity
  inventory.
- Message text never enters the work ledger, the Inbox or a Discord DM;
  Inbox rows about a friendship carry names only.

## Errors

All routes speak the PanelError contract (`{ error, code }` with the
status above): `BAD_USER_ID` 400, `CANNOT_FRIEND_SELF` 400,
`CANNOT_FRIEND_BOT` 400, `NO_SUCH_USER` 404, `BOT_OFFLINE` 503,
`RATE_LIMITED` 429, `ALREADY_FRIENDS` 409, `ALREADY_REQUESTED` 409,
`REQUEST_COOLDOWN` 429 (with `details.retryAt`), `NO_SUCH_REQUEST` 404,
`REQUEST_SETTLED` 409, `TOO_MANY_FRIENDS` 400, `NOT_FRIENDS` (404 from
unfriending someone you are not friends with; 403 from a direct-message
route), `CANNOT_MESSAGE_SELF` 400, `NO_SUCH_THREAD` 404, `EMPTY_MESSAGE`
400, `MESSAGE_TOO_LONG` 400, `BAD_CURSOR` 400.

## Tests

- `tests/friendService.test.js` - finding people by name, email and id;
  the request lifecycle (pending, accept, decline and its cooldown,
  cancel, remove, reopen, mutual auto-accept, self / bot / rate limit);
  the Discord buttons; the friend list with presence; `listInvitable`
  ordering and `hasFriends`; the Parlor picker; the HTTP routes end to
  end; erasure in both directions.
- `tests/directMessageService.test.js` - opening a thread requires
  friendship, sending and paging, read cursors and unread counts, the
  read-only thread after an unfriending, a stranger's access, erasure.
- `tests/webAppApi.test.js`, `tests/inboxService.test.js`,
  `tests/privacyService.test.js` - the routes, the Inbox payload and the
  report / erasure paths.
- `tests/portalRooms.test.js` and `e2e/navigation.spec.js` - the People
  room in the registry and the router.

SQLite and Postgres.
