# Goobster Casino - Discord Activity Setup

The table-games Activity ("Goobster Casino") is a multiplayer web app that runs
inside Discord voice channels and spends the same per-guild point currency as
`/points`, `/gamble`, and `/stocks`. The first game is **blackjack** (up to 5
seats, live dealer, sound effects); the framework under
`services/tableGames/` is game-agnostic so more table games can be added.

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

- One live table per guild + channel (`table_games` journal row).
- Bets are **escrowed immediately** through `economyService.adjust()`
  (`table-blackjack-bet` ledger entries) in the same SQLite transaction that
  journals the new table state - a bet can never be taken without the state
  that took it being durable.
- Payouts/pushes credit back on settlement (`table-blackjack-payout`);
  leaving before the deal refunds (`table-blackjack-refund`).
- On startup, `TableManager.recoverFromJournal()` refunds bets escrowed in
  hands that a crash interrupted, then clears the journal.
- Balances shown in the Activity are live wallet balances; everything appears
  in `/points history`.

## 5. Blackjack house rules (v1)

- 4-deck shoe, reshuffled every hand; dealer stands on all 17s.
- Blackjack pays 3:2 (rounded down to whole points); wins pay 1:1; pushes refund.
- Double down on any first two cards (one card, second escrow). No splits yet.
- 20s betting window once the first bet lands; 25s act timer (auto-stand);
  next hand deals ~6s after settlement.

## 6. Local development / testing

```json
{ "activity": { "enabled": true, "devMode": true } }
```

Open `http://localhost:3000/activity/?guild=<guildId>&channel=<anyId>` in one
or more browser tabs, pick a name per tab, and play. Dev identities get
wallets like real users (same guild economy), so use a test guild id if you
don't want test balances mixed into a live server's leaderboard.
