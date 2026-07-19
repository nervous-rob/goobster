# Goobster Casino - Discord Activity Setup

The table-games Activity ("Goobster Casino") is a multiplayer web app that runs
inside Discord voice channels and spends the same per-guild point currency as
`/points`, `/gamble`, and `/stocks`. A lobby offers four games — **blackjack**
(up to 5 seats, live dealer), **roulette** (European wheel, clickable betting
board), **baccarat** (punto banco), and **Texas Hold'em** (no-limit, and
Goobster himself can take a seat) — all with sound effects; the framework
under `services/tableGames/` is game-agnostic so more table games can be added.

Everything is **off by default**. Enabling it makes Goobster's public HTTP
server (the one that serves `/health`) also serve the Activity client and its
WebSocket API, because Discord's proxy must be able to reach it.

## 1. Configuration

In `config.json`:

```json
{
    "activity": {
        "enabled": true,
        "devMode": false,
        "clientSecret": "YOUR_OAUTH2_CLIENT_SECRET"
    }
}
```

- `enabled` - serves `/activity` (client) and `/api/activity/*` (auth + WebSocket)
  on the health server (`PORT`, default 3000).
- `clientSecret` - the OAuth2 client secret from the Developer Portal
  (**OAuth2 → Client Secret**), needed to exchange authorization codes. The
  environment variable `DISCORD_CLIENT_SECRET` takes precedence if set.
- `devMode` - allows minting arbitrary player identities via
  `/api/activity/dev-session` so the game can be played in a plain browser at
  `http://localhost:3000/activity/`. **Never enable on an internet-exposed
  server** - it bypasses Discord authentication entirely.

## 2. Public HTTPS exposure

Discord's Activity proxy needs a public HTTPS URL for your server. The
simplest way on a Raspberry Pi behind NAT is a Cloudflare tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

For a stable hostname, create a named tunnel (`cloudflared tunnel create
goobster`) and route a domain to it. Any reverse proxy with TLS works too.

## 3. Developer Portal setup

In the [Discord Developer Portal](https://discord.com/developers/applications),
on the same application the bot runs under:

1. **Activities → Enable Activities.** Discord auto-creates the "Launch"
   Entry Point command - no changes to `deploy-commands.js` are needed.
2. **Activities → URL Mappings.** Map prefix `/` to your public hostname
   (e.g. `goobster.example.com`). The client, API, and WebSocket all live on
   that one origin, so a single root mapping is enough.
3. **OAuth2 → Redirects.** Add any placeholder (e.g. `https://127.0.0.1`) -
   required by the portal, but the Embedded App SDK handles the redirect
   in-client.
4. Copy the **Client Secret** into `config.json` (or `DISCORD_CLIENT_SECRET`).

Restart Goobster. The launcher (rocket icon in a voice channel) now offers
the Activity; the client URL Discord loads is
`https://<clientId>.discordsays.com/…` which proxies to your mapping.

## 4. How money flows

- One live table per guild + channel (`table_games` journal row). The lobby
  picks the game for that table; while players are seated the running game
  wins and later joiners land in it, and once the table has no seated players
  a new lobby pick switches it in place.
- Bets are **escrowed immediately** through `economyService.adjust()`
  (`table-<game>-bet` ledger entries, e.g. `table-blackjack-bet`,
  `table-roulette-bet`, `table-baccarat-bet`) in the same SQLite transaction
  that journals the new table state - a bet can never be taken without the
  state that took it being durable.
- Payouts/pushes credit back on settlement (`table-<game>-payout`); leaving
  before the deal/spin - or clearing roulette bets - refunds
  (`table-<game>-refund`).
- On startup, `TableManager.recoverFromJournal()` refunds bets escrowed in
  hands that a crash interrupted, then clears the journal.
- Balances shown in the Activity are live wallet balances; everything appears
  in `/points history`.

## 5. Background music and sound

- Sound effects (cards, chips, win/lose jingles) are synthesized in the
  browser with WebAudio - no assets, no keys, always available. Toggle: 🔊.
- **Casino lounge music** loops in the background when an ElevenLabs key is
  configured: the first request to `/api/activity/music/casino` generates a
  2-minute instrumental jazz track via the ElevenLabs Music API (same paid
  plan the `/playmusic` command uses) and caches it at
  `cache/music/casino.mp3` - one-time cost, served from disk afterwards.
  Delete the file to regenerate. Without a key the endpoint returns 404 and
  the client simply plays no music. Toggle: 🎵 (persisted per browser).
- Music and effects are per-viewer (played by each player's client), not
  broadcast into the voice channel.

## 6. House rules (v1)

### Blackjack

- 4-deck shoe, reshuffled every hand; dealer stands on all 17s.
- Blackjack pays 3:2 (rounded down to whole points); wins pay 1:1; pushes refund.
- Double down on any first two cards (one card, second escrow). No splits yet.
- 20s betting window once the first bet lands; 25s act timer (auto-stand);
  next hand deals ~6s after settlement.

### Roulette

- European single-zero wheel, up to 8 seats, everyone bets at once.
- Bets: straight up (35:1), dozens and columns (2:1), red/black, odd/even,
  and 1-18/19-36 (1:1). Zero loses all outside bets (no la partage).
- Stack up to 20 bets per spin by clicking the board; "Clear bets" refunds
  them all before the spin.
- 30s betting window once the first chip lands (or any bettor presses
  "Spin now"); next round opens ~10s after the result.

### Baccarat (punto banco)

- 6-deck shoe, reshuffled every round; standard third-card tableau, no
  decisions after the bet.
- One bet per seat on player (1:1), banker (1:1 minus 5% commission, rounded
  down), or tie (8:1). Player/banker bets push on a tie. Up to 7 seats.
- 20s betting window; deals as soon as every seated player has bet (or a
  bettor presses "Deal now"); next round opens ~8s after settlement.

### Texas Hold'em (no-limit)

- Single deck per hand, up to 6 seats, blinds are `minBet/2` / `minBet`
  (button rotates; heads-up the button posts the small blind).
- **Wallet-backed betting**: every chip is escrowed from the wallet as it
  enters the pot, so there are no stacks, no all-ins, and no side pots (v1) -
  a raise is capped at 10,000 per street and a player who cannot cover a
  call folds instead.
- Hole cards are private per player (the first game with hidden information);
  everyone's cards are revealed only at showdown. Ties split the pot, odd
  chip to the earliest seat.
- Auto-deal ~15s after two players are seated (or press "Deal now"); 30s act
  timer (auto-check when free, auto-fold facing a bet); next hand ~10s after
  settlement. Leaving mid-hand folds and forfeits chips already in the pot.

## Goobster plays too (the table bot)

Any seated player - in **any** of the four games - can press **🤖 Invite
Goobster** to seat the bot (and "Kick Goobster" to remove it). Config,
under `activity.bot`:

```json
"bot": { "enabled": true, "textComments": false, "voiceComments": true }
```

- The bot plays with a real wallet (`bot-bankroll` ledger entries top it up
  when low). **Hold'em** decisions come from the configured AI provider -
  the personalized game view (its hole cards, pot, board, opponents) is
  serialized into an ONLY-JSON decision prompt - with a built-in heuristic
  fallback when no provider responds; model responses are always validated
  and clamped to legal moves. **Blackjack** plays simplified basic strategy;
  **roulette/baccarat** pick weighted random bets. In the chance games the
  bot follows, never leads: it only bets into a round a human already opened.
- The decision context builder (`buildDecisionContext` in
  `services/tableGames/botPlayer.js`) also accepts `images`, the extension
  point for feeding rendered table screenshots to vision models alongside
  the metadata.
- **Table talk**: the bot's comments always appear in the Activity as a
  speech bubble; `textComments: true` additionally posts them to the voice
  channel's text chat. With `voiceComments` (default **on**), the bot speaks
  its comments out loud whenever it is already in one of the guild's voice
  channels - through a live `/voicechat` session's TTS pipeline when one
  exists, or any other voice connection (music, `/speak`...). It never joins
  a voice channel on its own, and stays silent without an ElevenLabs key.
- The bot leaves automatically when the last human stands up.

## 7. Local development / testing

```json
{ "activity": { "enabled": true, "devMode": true } }
```

Open `http://localhost:3000/activity/?guild=<guildId>&channel=<anyId>` in one
or more browser tabs, pick a name per tab, and play. Dev identities get
wallets like real users (same guild economy), so use a test guild id if you
don't want test balances mixed into a live server's leaderboard. Add
`&autojoin=1` to skip the identity form and `&game=roulette` (or
`blackjack`/`baccarat`) to skip the lobby.
