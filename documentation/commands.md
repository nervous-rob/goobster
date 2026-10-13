---
title: "Slash command reference"
kind: reference
summary: Every Discord slash command and right-click menu, by category, with its description, subcommands and options - generated from apps/bot/commands by npm run docs:commands. Which commands work in DMs, which feature each belongs to, and how /help presents the same list inside Discord.
tags: [commands, discord, slash, reference, help, generated]
---

# Slash command reference

Generated from `apps/bot/commands` by `npm run docs:commands`; do not edit by hand. 74 commands and menus in 8 categories.

Inside Discord, `/help` shows the same commands grouped the same way, built from what the running bot has loaded, and `/help category:` lists one category with each command's description. A command marked *works in DMs* is registered globally and answers in direct messages as well as servers; every other command is server-only. A command whose feature is turned off on an installation ([features.md](features.md)) is not registered there and does not appear in `/help`.

## Categories

- **Chat** (6): `/chat`, `/joke`, `/poem`, `/recall`, `/speak`, `/voicechat`
- **Economy** (10): `/exchange`, `/futures`, `/gamble`, `/margin`, `/options`, `/orders`, `/points`, `/predict`, `/stocks`, `/wheel`
- **Images** (1): `/generate`
- **Music & audio** (13): `/aidj`, `/generateallambience`, `/generateallmusic`, `/generateambience`, `/generatemusic`, `/music`, `/play`, `/playambience`, `/playmusic`, `/playtrack`, `/spotdl`, `/stopambience`, `/stopmusic` and 1 right-click menu
- **Settings** (14): `/aisettings`, `/dynamicresponse`, `/instructions`, `/integrations`, `/memory`, `/monologue`, `/nickname`, `/personalitydirective`, `/privacy`, `/proactive`, `/replydetection`, `/requiresearchapproval`, `/thoughtfulmode`, `/threadpreference`
- **Tavern & adventures** (5): `/adventure`, `/character`, `/roll`, `/tavern`, `/world`
- **Utility** (23): `/agent`, `/attention`, `/automation`, `/cleanup`, `/createuser`, `/diagdb`, `/digest`, `/forget-me`, `/gbarun`, `/github`, `/help`, `/mememode`, `/ping`, `/resetchatdata`, `/screenvision`, `/search`, `/server`, `/systemstatus`, `/usage`, `/user`, `/what-do-you-know-about-me`, `/whatsnew`, `/wrapped`
- **Voice** (1): `/setvoice`

## Chat

### `/chat`

Start or continue a chat with Goobster *(works in DMs; feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `message` | text | yes | What would you like to say to Goobster? |
| `image` | attachment | no | An image for Goobster to look at |

### `/joke`

Tells a joke about the specified topic *(works in DMs; feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `category` | text | no | The category of joke Choices: `General`, `Programming`, `Dad Joke`, `Pun`, `Science`. |

### `/poem`

Generate a poem about a topic *(works in DMs; feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `topic` | text | no | Topic for the poem |
| `style` | text | no | Style of the poem Choices: `Free Verse`, `Haiku`, `Sonnet`, `Limerick`, `Epic`. |

### `/recall`

Ask the server's long-term memory anything. *(feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `question` | text | yes | What do you want to know? e.g. "what did we decide about the minecraft server?" |

### `/speak`

Speak text aloud in your voice channel (ElevenLabs) *(feature: `voice` + `discord`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `message` | text | yes | The text to convert to speech |
| `voice` | text | no | The voice style to use |
| `style` | text | no | Special voice style or effect Choices: `🎵 Sing`, `😄 Happy`, `😢 Sad`, `😠 Angry`, `🤔 Thinking`, `🎭 Dramatic`, `🎬 Movie Trailer`, `📻 Radio Host`, `🎮 Game Announcer`, `🌟 Enthusiastic`, `🤫 Whisper`, `🎪 Circus`. |
| `random_effects` | yes/no | no | Add random sound effects and emotions |
| `emphasize` | yes/no | no | CAPITALIZE random words for emphasis |
| `hesitate` | yes/no | no | Add hesitation marks (...) randomly |

### `/voicechat`

Have a live voice conversation with Goobster in your voice channel. *(feature: `voice` + `discord`)*

#### `/voicechat start`

Goobster joins your voice channel and starts listening

| Option | Type | Required | Description |
|---|---|---|---|
| `mode` | text | no | When Goobster replies (default: polite) Choices: `Polite - only when addressed or clearly needed`, `Open - replies to every turn`. |
| `engine` | text | no | Voice pipeline (default: realtime) Choices: `Realtime - low latency, interruptible (ElevenLabs STT+TTS)`, `Classic - batch pipeline (OpenAI STT + ElevenLabs TTS)`. |
| `transcript` | yes/no | no | Post a live transcript in this text channel (default: true) |

#### `/voicechat stop`

End the voice conversation

#### `/voicechat status`

Show whether a voice conversation is active

## Economy

### `/exchange`

Audit the exchange: accounts, the whole market, the engine log, and the rules. *(feature: `exchange`)*

#### `/exchange audit`

Server-wide audit: money supply, exposure, open interest, concentration

#### `/exchange account`

A full audit of one trader's exchange account

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose account (default: you) |

#### `/exchange leaderboard`

Traders ranked by equity - wallet plus positions, minus debt

#### `/exchange events`

What the risk engine has been doing

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Only this trader |
| `limit` | integer | no | How many entries (1-25) |

#### `/exchange reconcile`

Integrity checks: prove the books add up (Manage Server)

#### `/exchange tick`

Run the risk engine now: settle, fill, and mark every account (Manage Server)

#### `/exchange settings`

Turn instruments on or off and set the house rules (Manage Server)

| Option | Type | Required | Description |
|---|---|---|---|
| `margin` | yes/no | no | Allow margin accounts, leverage, and short selling |
| `options` | yes/no | no | Allow long calls and puts |
| `zero_dte` | yes/no | no | Allow same-day expiry contracts (needs options on) |
| `predictions` | yes/no | no | Allow event contracts |
| `futures` | yes/no | no | Allow perpetual futures (isolated margin) |
| `optin_override` | yes/no | no | Group events: treat everyone as opted in unless they opted out (default on) |
| `corporate_actions` | yes/no | no | Apply real dividends and splits (default on) |
| `max_leverage` | number | no | Highest leverage tier (1-10) |
| `max_perp_leverage` | number | no | Highest perp leverage (1-50) |
| `funding_rate` | number | no | Daily perp funding on notional, e.g. 0.0003 |
| `interest_rate` | number | no | Annual margin interest, e.g. 0.08 for 8% |
| `borrow_fee` | number | no | Annual short borrow fee, e.g. 0.05 |
| `maintenance` | number | no | Maintenance margin on longs, e.g. 0.25 |
| `short_maintenance` | number | no | Maintenance margin on shorts, e.g. 0.35 |
| `grace_minutes` | integer | no | Minutes a margin call may sit before liquidation |

### `/futures`

Perpetual futures - leveraged longs and shorts, isolated margin, crypto included. *(feature: `exchange`)*

#### `/futures open`

Open a perp (the margin you post is the most you can lose)

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker, e.g. BTC-USD, ETH-USD, TSLA |
| `direction` | text | yes | Long or short Choices: `long`, `short`. |
| `margin` | integer | yes | Points to post as margin |
| `leverage` | number | yes | e.g. 5 for 5x |

#### `/futures close`

Close a perp at the current mark

| Option | Type | Required | Description |
|---|---|---|---|
| `id` | integer | yes | Position id from /futures positions |

#### `/futures positions`

Open perps with live marks and liquidation prices

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose positions (default: you) |

### `/gamble`

Gamble your points: coin flips, d20 rolls, poker hands. *(feature: `gambling`)*

#### `/gamble coinflip`

Call heads or tails for even money

| Option | Type | Required | Description |
|---|---|---|---|
| `bet` | integer | yes | Points to wager |
| `call` | text | yes | Your call Choices: `Heads`, `Tails`. |

#### `/gamble d20`

Roll a d20 against Goobster - higher roll wins

| Option | Type | Required | Description |
|---|---|---|---|
| `bet` | integer | yes | Points to wager |

#### `/gamble poker`

Five-card showdown against the dealer

| Option | Type | Required | Description |
|---|---|---|---|
| `bet` | integer | yes | Points to wager |

### `/margin`

Margin account: leverage, buying power, loans, and your liquidation levels. *(feature: `exchange`)*

#### `/margin status`

Equity, buying power, debt, and how far the market can move against you

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose account (default: you) |

#### `/margin account`

Switch between a cash and a margin account

| Option | Type | Required | Description |
|---|---|---|---|
| `type` | text | yes | Account type Choices: `cash`, `margin`. |

#### `/margin leverage`

Set your leverage tier

| Option | Type | Required | Description |
|---|---|---|---|
| `multiple` | number | yes | e.g. 2 for 2x |

#### `/margin borrow`

Draw points from your margin loan

| Option | Type | Required | Description |
|---|---|---|---|
| `points` | integer | yes | How many points |

#### `/margin repay`

Repay your margin loan

| Option | Type | Required | Description |
|---|---|---|---|
| `points` | integer | no | How many points (omit to repay as much as you can) |

#### `/margin goblin`

Goblin Mode: deliberately unlock same-day (0DTE) contracts

| Option | Type | Required | Description |
|---|---|---|---|
| `enabled` | yes/no | yes | On or off |

### `/options`

Options trading - long calls and puts on real underlyings, priced in points. *(feature: `exchange`)*

#### `/options chain`

Option chain for a symbol (calls and puts around the money)

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker or index, e.g. AAPL or SPX |
| `expiry` | text | no | Expiry date YYYY-MM-DD (default: the nearest one) |
| `depth` | integer | no | Strikes each side of the money (1-8) |

#### `/options quote`

Price one contract, with greeks and probabilities

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker or index, e.g. SPX |
| `type` | text | yes | Call or put Choices: `call`, `put`. |
| `strike` | number | yes | Strike price |
| `expiry` | text | yes | Expiry date YYYY-MM-DD |

#### `/options expiries`

Which expiries are tradable right now

#### `/options buy`

Buy to open a long call or put

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker or index, e.g. SPX |
| `type` | text | yes | Call or put Choices: `call`, `put`. |
| `strike` | number | yes | Strike price |
| `expiry` | text | yes | Expiry date YYYY-MM-DD |
| `contracts` | integer | yes | How many contracts (100 shares each) |

#### `/options close`

Sell to close a contract you hold

| Option | Type | Required | Description |
|---|---|---|---|
| `id` | integer | yes | Position id from /options positions |
| `contracts` | integer | no | How many (omit to close all) |

#### `/options write`

Sell to open (write) a call or put - collects premium, owes the settlement

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker or index, e.g. SPX |
| `type` | text | yes | Call or put Choices: `call`, `put`. |
| `strike` | number | yes | Strike price |
| `expiry` | text | yes | Expiry date YYYY-MM-DD |
| `contracts` | integer | yes | How many contracts (100 shares each) |

#### `/options buyback`

Buy to close a contract you wrote

| Option | Type | Required | Description |
|---|---|---|---|
| `id` | integer | yes | Position id from /options positions |
| `contracts` | integer | no | How many (omit to close all) |

#### `/options spread`

Multi-leg order with a pre-trade receipt - verticals, condors, straddles, butterflies

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Underlying, e.g. SPCX |
| `legs` | text | yes | e.g. "buy 100p, sell 76p, buy 130c, sell 155c" |
| `expiry` | text | yes | Expiry date YYYY-MM-DD for all legs |
| `contracts` | integer | no | Contracts per leg (default 1; "x2" in a leg overrides) |
| `fire` | yes/no | no | true = execute; default false shows the receipt only |

#### `/options positions`

Your open contracts with live greeks and P/L

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose positions (default: you) |

#### `/options history`

Your recent option fills and settlements (ephemeral)

### `/orders`

Resting orders: limit, stop, stop-limit, and trailing stop. *(feature: `exchange`)*

#### `/orders place`

Rest an order until the market comes to it

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker, e.g. AAPL |
| `side` | text | yes | What the fill does Choices: `buy (open/add a long)`, `sell (close a long)`, `short (open a short)`, `cover (close a short)`. |
| `type` | text | yes | Order type Choices: `limit`, `stop`, `stop-limit`, `trailing stop`. |
| `units` | number | yes | How many shares |
| `limit` | number | no | Limit price (limit and stop-limit orders) |
| `stop` | number | no | Stop price (stop and stop-limit orders) |
| `trail` | number | no | Trail percent (trailing stops) |
| `good_for_hours` | integer | no | Cancel automatically after this many hours |

#### `/orders list`

Your orders

| Option | Type | Required | Description |
|---|---|---|---|
| `show` | text | no | Which orders (default: working) Choices: `working`, `all`. |

#### `/orders cancel`

Cancel a working order

| Option | Type | Required | Description |
|---|---|---|---|
| `id` | integer | yes | Order id from /orders list |

### `/points`

Your server point currency - balance, daily claim, transfers, leaderboard. *(feature: `economy`)*

#### `/points balance`

Check a balance

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose balance (default: you) |

#### `/points daily`

Claim your daily allowance

#### `/points give`

Send points to another member

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | yes | Recipient |
| `amount` | integer | yes | How much to send |

#### `/points leaderboard`

Richest members in this server

#### `/points history`

Your recent transactions (ephemeral)

#### `/points admin name`

Rename the currency (e.g. "Jimmy points")

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | New currency name |

#### `/points admin grant`

Grant (or remove, with a negative amount) points

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | yes | Member |
| `amount` | integer | yes | Points to add (negative to remove) |

#### `/points admin config`

Set starting balance and/or daily amount

| Option | Type | Required | Description |
|---|---|---|---|
| `starting_balance` | integer | no | Balance new wallets start with |
| `daily_amount` | integer | no | Points per daily claim (0 disables) |

### `/predict`

Event contracts - bet on where a price lands, settled automatically from the market. *(feature: `gambling` + `exchange`)*

#### `/predict markets`

Open markets and their current prices

#### `/predict buy`

Buy contracts on one side of a market

| Option | Type | Required | Description |
|---|---|---|---|
| `market` | integer | yes | Market id from /predict markets |
| `side` | text | yes | Which side Choices: `yes`, `no`. |
| `contracts` | integer | yes | How many (each pays 100 if right) |

#### `/predict positions`

Your event contracts

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose positions (default: you) |

#### `/predict create`

Open a new market (Manage Server)

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker the market settles against, e.g. RKLB |
| `comparator` | text | yes | Above or below the threshold Choices: `above`, `below`. |
| `threshold` | number | yes | Price threshold |
| `resolves` | text | yes | When it settles, YYYY-MM-DD HH:MM UTC |
| `question` | text | no | Custom wording (optional) |
| `cap` | integer | no | Max contracts per trader per side (default 500) |

#### `/predict void`

Void a market and refund every contract (Manage Server)

| Option | Type | Required | Description |
|---|---|---|---|
| `market` | integer | yes | Market id |
| `reason` | text | no | Why |

### `/stocks`

Stock trading game - invest your points at real market prices (1 point = $1). *(feature: `exchange`)*

#### `/stocks quote`

Current price of a stock

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker, e.g. AAPL |

#### `/stocks search`

Find a ticker by company name

| Option | Type | Required | Description |
|---|---|---|---|
| `query` | text | yes | Company name or ticker fragment |

#### `/stocks buy`

Buy stock units with your points

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker, e.g. AAPL |
| `units` | number | yes | How many shares (fractions allowed) |

#### `/stocks sell`

Sell stock units back into points

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker you hold |
| `units` | number | no | How many shares (omit to sell all) |

#### `/stocks short`

Sell borrowed shares now and buy them back later (needs a margin account)

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker to short |
| `units` | number | yes | How many shares |

#### `/stocks cover`

Buy back shares you shorted

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker you are short |
| `units` | number | no | How many shares (omit to cover all) |

#### `/stocks portfolio`

Check in on your positions (refreshes prices)

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose portfolio (default: you) |

#### `/stocks chart`

Historical price graph for a stock

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | yes | Ticker, e.g. AAPL |
| `range` | text | no | History window (default 3mo) Choices: `1 month`, `3 months`, `6 months`, `1 year`. |

#### `/stocks trades`

Your recent buys and sells (ephemeral)

### `/wheel`

The Ballistic Goblin Wheel - group call-buying, coordinates revealed by fate. *(feature: `gambling` + `exchange`)*

#### `/wheel spin`

Spin both wheels NOW and deploy for every participant (Manage Server)

| Option | Type | Required | Description |
|---|---|---|---|
| `symbol` | text | no | Underlying (default SPX) |

#### `/wheel optin`

Join the ritual

| Option | Type | Required | Description |
|---|---|---|---|
| `max_percent` | number | no | Personal cap on how much of your wallet one spin may deploy |

#### `/wheel optout`

Leave the ritual (wins over the server-wide override, always)

#### `/wheel status`

Your opt-in state, the override, and the participant count

#### `/wheel participants`

Who rides on the next spin

#### `/wheel override`

The override-all switch: treat everyone as opted in (Manage Server)

| Option | Type | Required | Description |
|---|---|---|---|
| `enabled` | yes/no | yes | On or off |

#### `/wheel schedule`

Spin daily at US market open, 9:30 AM ET, in this channel (Manage Server)

#### `/wheel unschedule`

Stop the daily dedication (Manage Server)

## Images

### `/generate`

Generate an image using AI *(works in DMs; feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `prompt` | text | yes | What to generate |
| `type` | text | yes | Type of image to generate Choices: `Character`, `Location`, `Item`, `Scene`. |
| `style` | text | no | Style of the image Choices: `Fantasy (Default)`, `Realistic`, `Anime`, `Comic`, `Watercolor`, `Oil Painting`. |
| `quality` | text | no | Quality of the generated image Choices: `Standard`, `HD`. |
| `usereference` | yes/no | no | Use a reference image? |
| `referencepath` | text | no | Path to reference image (if using reference) |

## Music & audio

### `/aidj`

Let the AI DJ take over your voice channel and spin some tunes! *(feature: `music` + `voice` + `discord`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `theme` | text | yes | Describe the vibe (e.g. "lofi study", "80s synthwave", "upbeat pop") |
| `volume` | integer | no | Music volume percent (1–100) |

### `/generateallambience`

Generate and cache all ambient sound effects (Admin only) *(feature: `music`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `force` | yes/no | no | Force regeneration even if files exist |
| `concurrency` | integer | no | Number of tracks to generate in parallel (1-2) |

### `/generateallmusic`

Generate and cache music for all moods (Admin only) *(feature: `music`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `force` | yes/no | no | Force regeneration even if files exist |
| `concurrency` | integer | no | Number of tracks to generate in parallel (1-3) |

### `/generateambience`

Generate ambient sound for a specific environment *(feature: `music`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `type` | text | yes | The type of ambient sound to generate Choices: `🌲 Forest`, `🕳️ Cave`, `🍺 Tavern`, `🌊 Ocean`, `🏙️ City`, `⛓️ Dungeon`, `🔥 Camp`, `⛈️ Storm`. |
| `force` | yes/no | no | Force regeneration even if files exist |

### `/generatemusic`

Generate music for a specific mood *(feature: `music`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `mood` | text | yes | The mood of the music to generate Choices: `⚔️ Battle`, `🌄 Exploration`, `🔍 Mystery`, `🎉 Celebration`, `⚠️ Danger`, `🌿 Peaceful`, `😢 Sad`, `🎭 Dramatic`. |
| `force` | yes/no | no | Force regeneration even if files exist |

### Right-click menu: Goobster Controls

A message context menu (feature: `music` + `voice` + `discord`). Source: `music/contextMenu.js`.

### `/music`

Music playback & playlist commands *(feature: `music` + `voice` + `discord`)*

#### `/music play`

Play or queue a track

| Option | Type | Required | Description |
|---|---|---|---|
| `track` | text | yes | Track to play – "artist - title" |

#### `/music now`

Show the current queue / now playing

#### `/music skip`

Skip the current track

#### `/music pause`

Pause playback

#### `/music resume`

Resume playback

#### `/music stop`

Stop playback & clear queue

#### `/music volume`

Adjust volume

| Option | Type | Required | Description |
|---|---|---|---|
| `level` | integer | yes | Volume level 0-100 |

#### `/music playlist create`

Create a playlist

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Playlist name |

#### `/music playlist add`

Add a track to a playlist

| Option | Type | Required | Description |
|---|---|---|---|
| `playlist_name` | text | yes | Playlist |
| `track` | text | yes | Track search |

#### `/music playlist play`

Play a playlist

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Playlist |

#### `/music playlist list`

List saved playlists

#### `/music playlist delete`

Delete a playlist

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Playlist |

#### `/music playlist fromsearch`

Create playlist from search

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Playlist name |
| `search_query` | text | yes | Search query |

#### `/music library list`

List all tracks

#### `/music library playall`

Play all tracks in order

#### `/music library shuffle`

Shuffle play all tracks

### `/play`

Play audio from a YouTube or Spotify URL in your voice channel *(feature: `music` + `voice` + `discord`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `url` | text | yes | YouTube video/playlist URL or Spotify track/playlist/album URL |

### `/playambience`

Play ambient sound effects *(feature: `music` + `voice` + `discord`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `type` | text | yes | The type of ambient sound to play Choices: `Forest`, `Cave`, `Tavern`, `Ocean`, `City`, `Dungeon`, `Camp`, `Storm`. |
| `volume` | number | no | Volume of the ambient sound (0.1 to 1.0) |

### `/playmusic`

Play background music with a specific mood *(feature: `music` + `voice` + `discord`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `mood` | text | yes | The mood of the music to play Choices: `⚔️ Battle`, `🌄 Exploration`, `🔍 Mystery`, `🎉 Celebration`, `⚠️ Danger`, `🌿 Peaceful`, `😢 Sad`, `🎭 Dramatic`. |
| `loop` | yes/no | no | Whether to loop the music continuously |
| `volume` | number | no | Set the volume (0.1-1.0) |
| `regenerate` | yes/no | no | Regenerate the music even if it exists in cache |

### `/playtrack`

Play and manage music tracks *(feature: `music` + `voice` + `discord`)*

#### `/playtrack play`

Play a track or add it to the queue

| Option | Type | Required | Description |
|---|---|---|---|
| `track` | text | yes | Name of the track to play/queue (artist - title) |

#### `/playtrack list`

List all available tracks

#### `/playtrack queue`

Show the current queue

#### `/playtrack skip`

Skip the current track

#### `/playtrack pause`

Pause the current track

#### `/playtrack resume`

Resume the current track

#### `/playtrack stop`

Stop playback and clear the queue

#### `/playtrack volume`

Adjust the volume

| Option | Type | Required | Description |
|---|---|---|---|
| `level` | integer | yes | Volume level (0-100) |

#### `/playtrack playlist_create`

Create a new empty playlist

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | The name for the new playlist |

#### `/playtrack playlist_add`

Add a track to a playlist

| Option | Type | Required | Description |
|---|---|---|---|
| `playlist_name` | text | yes | The name of the playlist |
| `track` | text | yes | Name of the track to add (search query) |

#### `/playtrack playlist_play`

Play a specific playlist

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | The name of the playlist to play |

#### `/playtrack playlist_list`

List all your saved playlists

#### `/playtrack playlist_delete`

Delete a playlist

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | The name of the playlist to delete |

#### `/playtrack play_all`

Play all available tracks in order

#### `/playtrack shuffle_all`

Play all available tracks in shuffle mode

#### `/playtrack playlist_create_from_search`

Create a new playlist from track search results

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | The name for the new playlist |
| `search_query` | text | yes | The search query for tracks to include |

### `/spotdl`

Download and manage music tracks from Spotify or YouTube *(feature: `music`)*

#### `/spotdl download`

Download a track, playlist, or album from Spotify or YouTube

| Option | Type | Required | Description |
|---|---|---|---|
| `url` | text | yes | Spotify track/playlist/album URL or YouTube video/playlist URL |
| `save_as_playlist` | text | no | Optional: Save downloaded tracks as a new/updated playlist |

#### `/spotdl list`

List all downloaded tracks

#### `/spotdl delete`

Delete a track

| Option | Type | Required | Description |
|---|---|---|---|
| `track` | text | yes | Name of the track to delete (artist - title) |

### `/stopambience`

Stop playing ambient sound effects *(feature: `music` + `voice` + `discord`)*

### `/stopmusic`

Stop the currently playing background music *(feature: `music` + `voice` + `discord`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `fadeduration` | number | no | Duration of fade-out in seconds (1-10) |

## Settings

### `/aisettings`

Configure which AI provider and model Goobster uses in this server or DM. *(works in DMs; feature: `core`)*

#### `/aisettings set`

Override the AI provider/model for this server

| Option | Type | Required | Description |
|---|---|---|---|
| `provider` | text | no | AI provider Choices: `OpenAI`, `Anthropic Claude`, `Google Gemini`, `Ollama (local)`. |
| `model` | text | no | Model ID, e.g. gpt-5.6-terra or gemini-3.5-flash |
| `reasoning` | text | no | Reasoning effort (OpenAI, Anthropic, and Gemini) Choices: `None (when supported)`, `Minimal`, `Low`, `Medium`, `High`, `Extra high (when supported)`, `Maximum (when supported)`. |

#### `/aisettings reset`

Clear overrides and use the global defaults

#### `/aisettings status`

Show the AI configuration for this server

### `/dynamicresponse`

Configure Goobster's ability to respond to messages without being explicitly mentioned *(feature: `core`)*

#### `/dynamicresponse enable`

Enable Goobster to respond dynamically based on message context and content

#### `/dynamicresponse disable`

Disable dynamic responses, requiring explicit mentions to trigger Goobster

#### `/dynamicresponse status`

Check the current status of the dynamic response feature

### `/instructions`

Your custom instructions - how Goobster should respond to you, everywhere. *(works in DMs; feature: `core`)*

#### `/instructions view`

Show your current custom instructions

#### `/instructions set`

Set your custom instructions (replaces the previous text)

| Option | Type | Required | Description |
|---|---|---|---|
| `text` | text | yes | How should Goobster respond? Anything it should know about you? |

#### `/instructions clear`

Remove your custom instructions

### `/integrations`

Your personal platform integrations (Notion, GitHub) - status and disconnect. *(works in DMs; feature: `core`)*

#### `/integrations status`

Show which platforms your account has connected

#### `/integrations disconnect`

Disconnect one platform (deletes the stored token)

| Option | Type | Required | Description |
|---|---|---|---|
| `platform` | text | yes | The platform to disconnect Choices: `GitHub`, `Notion`. |

### `/memory`

Manage Goobster's long-term memory for this server. *(feature: `core`)*

#### `/memory status`

Show memory stats for this server

#### `/memory recall`

Test what Goobster remembers about a topic

| Option | Type | Required | Description |
|---|---|---|---|
| `topic` | text | yes | What to search memories for |

#### `/memory forget`

Delete ALL long-term memories for this server

### `/monologue`

Control Goobster's internal monologue (private thoughts, scratch pad, knowledge graph). *(feature: `core`)*

#### `/monologue enable`

Let Goobster keep a private thought process about this server

#### `/monologue disable`

Stop the internal monologue (existing thoughts and graph are kept)

#### `/monologue status`

Show monologue status: thoughts, scratch pad, and knowledge graph size

#### `/monologue thoughts`

Peek at Goobster's recent private thoughts and scratch pad

#### `/monologue graph`

Show the most salient knowledge graph nodes and their links

#### `/monologue reset`

Erase all private thoughts, scratch pad notes, and the knowledge graph

### `/nickname`

Manage nicknames for Goobster and users *(works in DMs; feature: `core`)*

#### `/nickname bot set`

Set a custom nickname for Goobster in this server

| Option | Type | Required | Description |
|---|---|---|---|
| `nickname` | text | yes | The new nickname for Goobster (max 32 characters) |

#### `/nickname bot clear`

Clear Goobster's custom nickname in this server

#### `/nickname bot view`

View Goobster's current nickname in this server

#### `/nickname user set`

Set your custom nickname

| Option | Type | Required | Description |
|---|---|---|---|
| `nickname` | text | yes | Your new nickname (max 32 characters) |

#### `/nickname user clear`

Clear your custom nickname

#### `/nickname user view`

View your current nickname

### `/personalitydirective`

Configure Goobster's personality for this server or DM *(works in DMs; feature: `core`)*

#### `/personalitydirective set`

Set a custom personality directive for Goobster

| Option | Type | Required | Description |
|---|---|---|---|
| `directive` | text | yes | The personality directive that will modify Goobster's behavior |

#### `/personalitydirective clear`

Remove the custom personality directive and restore default behavior

#### `/personalitydirective view`

View the current personality directive

### `/privacy`

Control what Goobster remembers here. *(works in DMs; feature: `core`)*

#### `/privacy status`

Show retention and memory scope settings

#### `/privacy retention`

Auto-delete long-term memories older than N days

| Option | Type | Required | Description |
|---|---|---|---|
| `days` | integer | yes | Days to keep memories (0 = keep forever) |

#### `/privacy exclude`

Stop remembering a channel (and forget what's already stored from it)

| Option | Type | Required | Description |
|---|---|---|---|
| `channel` | channel | yes | Channel Goobster must not remember |

#### `/privacy include`

Resume remembering a previously excluded channel

| Option | Type | Required | Description |
|---|---|---|---|
| `channel` | channel | yes | Channel to remember again |

### `/proactive`

Control Goobster's proactive mode (its "heartbeat" - unprompted participation). *(feature: `core`)*

#### `/proactive enable`

Let Goobster occasionally chime in, react, and follow up on its own

#### `/proactive disable`

Goobster only responds when addressed

#### `/proactive status`

Show proactive mode status, known facts, and pending follow-ups

### `/replydetection`

Configure whether Goobster answers replies to its own messages without a mention *(feature: `core`)*

#### `/replydetection enable`

Answer messages that follow one of Goobster's and read as a reply to it

#### `/replydetection disable`

Require a mention, a nickname, or a Discord reply every time

#### `/replydetection status`

Check the current reply detection setting

### `/requiresearchapproval`

Configure whether search requests require admin approval *(feature: `core`)*

#### `/requiresearchapproval set`

Set the search approval requirement for this server

| Option | Type | Required | Description |
|---|---|---|---|
| `setting` | text | yes | Choose whether search requests require approval Choices: `Require approval for searches`, `Allow searches without approval`. |

#### `/requiresearchapproval status`

Check the current search approval setting for this server

### `/thoughtfulmode`

Toggle Goobster's Thoughtful Mode (deeper reasoning at higher latency/cost). *(works in DMs; feature: `core`)*

#### `/thoughtfulmode enable`

Enable Thoughtful Mode (the provider's top model with high reasoning effort)

#### `/thoughtfulmode disable`

Disable Thoughtful Mode (revert to the default model)

#### `/thoughtfulmode status`

Show whether Thoughtful Mode is currently enabled

### `/threadpreference`

Configure how Goobster responds to messages *(feature: `core`)*

#### `/threadpreference set`

Set the thread preference for this server

| Option | Type | Required | Description |
|---|---|---|---|
| `preference` | text | yes | Choose where Goobster should respond to messages Choices: `Always use threads`, `Always use the current channel`. |

#### `/threadpreference status`

Check the current thread preference for this server

## Tavern & adventures

### `/adventure`

Adventure Mode - accept a rumor, bounty, or terrible idea. *(feature: `tavern`)*

#### `/adventure browse`

Browse the Quest Board

#### `/adventure join`

Join the party forming here, or post a new one for a quest

| Option | Type | Required | Description |
|---|---|---|---|
| `quest` | text | no | Quest to post a new party for (omit to join the one forming here) |

#### `/adventure invite-goobster`

Invite Goobster itself to play in your forming party

#### `/adventure begin`

Begin this channel's adventure once the party is ready

#### `/adventure act`

Do something else entirely - describe your action in your own words

| Option | Type | Required | Description |
|---|---|---|---|
| `action` | text | yes | What do you do? |

#### `/adventure attack`

Attack a foe in the current encounter

| Option | Type | Required | Description |
|---|---|---|---|
| `enemy` | text | yes | Which foe |
| `stat` | text | no | Attack with which stat (default: your best of Might/Finesse) Choices: `Might`, `Finesse`, `Wits`, `Heart`. |

#### `/adventure twist`

Bend the story: Goobster writes new scenes that tie your idea back into the campaign

| Option | Type | Required | Description |
|---|---|---|---|
| `description` | text | yes | What should happen instead? |

#### `/adventure bigmove`

Fire your Calling's once-per-adventure big moment: your next check succeeds

#### `/adventure status`

Where were we? Re-post the current scene or party card

#### `/adventure recap`

The recap of the last completed adventure here

#### `/adventure leave`

Leave your current party (no penalty, ever)

#### `/adventure abandon`

Abandon this channel's adventure (party founder or Manage Server)

### `/character`

Your Tavern character - create and manage your sheet. *(feature: `tavern`)*

#### `/character create`

Make a character: distribute 6 points across four stats (each 0-3)

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Character name |
| `origin` | text | yes | Background in one flavorful phrase, e.g. "Retired goblin tax collector" |
| `calling` | text | yes | Your broad archetype Choices: `Vanguard — Protector, fighter, bodyguard.`, `Scoundrel — Trickster, thief, duelist, swindler.`, `Mystic — Mage, witch, psychic, alchemist.`, `Guide — Ranger, healer, scholar, diplomat.`, `Tinkerer — Inventor, mechanic, artificer.`, `Troubadour — Performer, morale-maker, storyteller.`, `Oddity — A customizable strange archetype for server-specific chaos.`. |
| `complication` | text | yes | Your flaw/hook, e.g. "Cannot resist a dare" - it earns you Spark |
| `might` | integer | yes | Might 0-3: force, endurance, fighting |
| `finesse` | integer | yes | Finesse 0-3: stealth, reflexes, precision |
| `wits` | integer | yes | Wits 0-3: knowledge, investigation, planning |
| `heart` | integer | yes | Heart 0-3: charm, courage, empathy |
| `pronouns` | text | no | Optional pronouns |

#### `/character sheet`

View a character sheet

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose sheet (default: you) |

#### `/character edit`

Edit your character's descriptive fields

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | no | New name |
| `origin` | text | no | New origin phrase |
| `complication` | text | no | New complication |
| `pronouns` | text | no | New pronouns (empty text clears) |

#### `/character advance`

Spend a milestone to raise a stat by one

| Option | Type | Required | Description |
|---|---|---|---|
| `stat` | text | yes | Which stat to raise Choices: `Might`, `Finesse`, `Wits`, `Heart`. |

#### `/character inventory`

Your pack: view it, use a consumable, hand something over, or drop it

| Option | Type | Required | Description |
|---|---|---|---|
| `action` | text | yes | What to do Choices: `view`, `use (during an adventure)`, `give to a party member`, `drop`. |
| `item` | text | no | Which item (for use/give/drop) |
| `user` | user | no | Recipient (for give) |

#### `/character retire`

Retire your character permanently (asks for confirmation)

### `/roll`

Roll dice - stat checks or free expressions. *(feature: `tavern`)*

#### `/roll check`

d20 + your character's stat, optionally against a difficulty

| Option | Type | Required | Description |
|---|---|---|---|
| `stat` | text | yes | Which stat Choices: `Might`, `Finesse`, `Wits`, `Heart`. |
| `dc` | integer | no | Difficulty to beat Choices: `routine (10)`, `challenging (13)`, `difficult (16)`, `heroic (19)`, `legendary (22)`. |

#### `/roll dice`

Roll a dice expression

| Option | Type | Required | Description |
|---|---|---|---|
| `expression` | text | yes | e.g. d20, 2d6+1, 4d8-2 |

### `/tavern`

The Goobster Tavern - a magical inn between worlds. *(feature: `tavern`)*

#### `/tavern status`

Step into the Common Room: rumors, quests, and who's around

#### `/tavern board`

Read the full Quest Board

#### `/tavern rumor`

Today's rumor, fresh from the bar

#### `/tavern npc`

Chat up one of the Tavern's residents

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Who to talk to Choices: `Marnie Quill`, `Bix Copperthumb`, `Sister Caldra`, `Albert E. Littlefield`. |

#### `/tavern profile`

A member's tavern profile (their character and trophies)

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose profile (default: you) |

#### `/tavern room`

Visit a Guest Room upstairs (trophies, standing, decor)

| Option | Type | Required | Description |
|---|---|---|---|
| `user` | user | no | Whose room (default: yours) |

#### `/tavern room-edit`

Describe your Guest Room (empty text moves you back out)

| Option | Type | Required | Description |
|---|---|---|---|
| `description` | text | yes | Your room, in your words |

#### `/tavern generate-art`

Generate scene art for a quest into data/tavern/assets (Manage Server, needs OpenAI)

| Option | Type | Required | Description |
|---|---|---|---|
| `quest` | text | yes | Which quest |
| `force` | yes/no | no | Regenerate scenes that already have art |

#### `/tavern forge`

Have Goobster write a whole new campaign onto the quest board (Manage Server, needs AI)

| Option | Type | Required | Description |
|---|---|---|---|
| `prompt` | text | yes | What should the adventure be about? |

#### `/tavern reload-quests`

Reload campaign YAML files from disk (Manage Server)

### `/world`

The living shared world your adventures have written. *(feature: `tavern`)*

#### `/world map`

The Map Room: everything this server has discovered

#### `/world lore`

Read one lore entry in full

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Which entry |

## Utility

### `/agent`

Launch and manage Cursor cloud coding agents. *(feature: `cursor`)*

#### `/agent launch`

Launch a coding agent against a watched repository

| Option | Type | Required | Description |
|---|---|---|---|
| `repo` | text | yes | Repository (owner/name, must be watched) |
| `prompt` | text | yes | What the agent should do |
| `branch` | text | no | Starting branch (default: repo default) |
| `model` | text | no | Model ID (default: account default) |
| `auto_pr` | yes/no | no | Open a PR when done (default: true) |

#### `/agent status`

Recent agent runs launched from this server

#### `/agent models`

List the model IDs agents can be launched with

#### `/agent followup`

Send a follow-up prompt to an agent

| Option | Type | Required | Description |
|---|---|---|---|
| `agent_id` | text | yes | Agent id (bc-...) |
| `prompt` | text | yes | Follow-up instructions |

#### `/agent cancel`

Cancel an agent's active run

| Option | Type | Required | Description |
|---|---|---|---|
| `agent_id` | text | yes | Agent id (bc-...) |

### `/attention`

Control whether Goobster keeps track of your open loops and reaches out on its own. *(works in DMs; feature: `core`)*

#### `/attention enable`

Let Goobster track what matters to you and decide when to speak up

| Option | Type | Required | Description |
|---|---|---|---|
| `initiative` | text | no | How much initiative it gets (default: nudge) Choices: `observe - notices, never reaches out`, `nudge - may surface useful things`, `assist - may also do read-only work`, `delegate - may take pre-authorized action`. |

#### `/attention disable`

Stop proactive attention (your ledger and settings are kept)

#### `/attention status`

Show your initiative level, open loops, and armed watches

#### `/attention inbox`

Everything Goobster noticed but did not interrupt you about

#### `/attention dismiss`

Dismiss a notice (which also teaches him to raise that kind less)

| Option | Type | Required | Description |
|---|---|---|---|
| `id` | integer | yes | The notice id from /attention inbox |

#### `/attention quiet`

Set do-not-disturb hours (UTC), or clear them

| Option | Type | Required | Description |
|---|---|---|---|
| `start` | integer | no | Start hour, 0-23 (omit both to clear) |
| `end` | integer | no | End hour, 0-23 |

#### `/attention budget`

Cap how often it may reach out

| Option | Type | Required | Description |
|---|---|---|---|
| `per-day` | integer | no | Maximum DMs per day (0-20) |
| `cooldown` | integer | no | Minimum minutes between DMs (5-1440) |

#### `/attention watches`

Show the conditions it is currently waiting on

### `/automation`

Manage scheduled AI tasks and messages *(works in DMs; feature: `core`)*

#### `/automation create`

Create a scheduled AI task

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Name for this automation |
| `prompt` | text | yes | Task to run; actionable requests can use registered tools |
| `schedule` | text | yes | When to trigger (e.g., "every day at 9am" or "every Monday at 3:30pm") |

#### `/automation list`

List your automated message triggers

#### `/automation toggle`

Enable or disable an automation

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Name of the automation to toggle |
| `enabled` | yes/no | yes | Whether to enable or disable the automation |

#### `/automation delete`

Delete an automation

| Option | Type | Required | Description |
|---|---|---|---|
| `name` | text | yes | Name of the automation to delete |

### `/cleanup`

Delete recent messages from Goobster *(feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `amount` | integer | no | Number of messages to check (default: 100) |

### `/createuser`

Creates a new user in the database. *(feature: `core`)*

### `/diagdb`

Diagnose database connectivity issues *(feature: `core`)*

### `/digest`

AI summaries of channel activity. *(feature: `core`)*

#### `/digest now`

Summarize this channel's recent activity

| Option | Type | Required | Description |
|---|---|---|---|
| `hours` | integer | no | How far back to look (default 24, max 72) |

#### `/digest schedule`

Schedule a recurring digest of this channel

| Option | Type | Required | Description |
|---|---|---|---|
| `when` | text | yes | Natural language schedule, e.g. "every day at 9pm" |
| `hours` | integer | no | Window each digest covers (default 24) |

### `/forget-me`

Erase everything Goobster knows about you, bot-wide. Cannot be undone. *(works in DMs; feature: `core`)*

### `/gbarun`

Broadcast a GBA game run (Goobster Plays Pokémon) into a channel *(feature: `gba`)*

#### `/gbarun link`

Get a one-time code to pair the run harness on your gaming machine

| Option | Type | Required | Description |
|---|---|---|---|
| `channel` | channel | no | Channel the run posts into (default: this channel) |

#### `/gbarun unlink`

Remove the pairing and disconnect the run harness

#### `/gbarun status`

Check whether the run harness is paired and connected

### `/github`

GitHub repository integration. *(feature: `github`)*

#### `/github watch`

Post repo events into a channel (also allowlists the repo for chat tools)

| Option | Type | Required | Description |
|---|---|---|---|
| `repo` | text | yes | Repository (owner/name or URL) |
| `channel` | channel | no | Channel for events (default: here) |
| `events` | text | no | Comma-separated: push, pull_request, issues, release, ci (default: all) |

#### `/github unwatch`

Stop watching a repository

| Option | Type | Required | Description |
|---|---|---|---|
| `repo` | text | yes | Repository (owner/name) |

#### `/github watches`

List this server's watched repositories

#### `/github repo`

Repository overview

| Option | Type | Required | Description |
|---|---|---|---|
| `repo` | text | yes | Repository (owner/name or URL) |

#### `/github pr`

Summarize a pull request

| Option | Type | Required | Description |
|---|---|---|---|
| `repo` | text | yes | Repository (owner/name) |
| `number` | integer | yes | PR number |

#### `/github issue`

Show an issue

| Option | Type | Required | Description |
|---|---|---|---|
| `repo` | text | yes | Repository (owner/name) |
| `number` | integer | yes | Issue number |

### `/help`

List the available commands, by category *(works in DMs; feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `category` | text | no | One category of commands Choices: `Chat`, `Economy`, `Images`, `Music & audio`, `Settings`, `Tavern & adventures`, `Utility`, `Voice`. |

### `/mememode`

Toggle meme mode for more meme-flavored responses *(works in DMs; feature: `core`)*

#### `/mememode toggle`

Turn meme mode on or off

| Option | Type | Required | Description |
|---|---|---|---|
| `enabled` | yes/no | yes | Whether to enable or disable meme mode |

#### `/mememode status`

Check if meme mode is currently enabled

### `/ping`

Replies with Pong and checks DB connectivity! *(works in DMs; feature: `core`)*

### `/resetchatdata`

Deletes all of the user's prompts, conversations, and messages. *(feature: `core`)*

### `/screenvision`

Let Goobster see your screen via the companion app (opt-in) *(works in DMs; feature: `screenVision`)*

#### `/screenvision link`

Get a one-time code to pair the companion app on your PC

#### `/screenvision unlink`

Remove your pairing and disconnect the companion app

#### `/screenvision status`

Check whether your companion app is paired and connected

#### `/screenvision test`

Take a test screenshot through your companion app

### `/search`

Search the web using Perplexity AI *(feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `query` | text | yes | What would you like to search for? |
| `reason` | text | no | (AI Only) Reason for search request |

### `/server`

Provides information about the server. *(feature: `core`)*

### `/systemstatus`

Show host system health: CPU, memory, temperature, disk, and bot stats. *(feature: `core`)*

### `/usage`

Show AI usage (token counts) for this server. *(feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `days` | integer | no | Time window in days (default 7) Choices: `Last 24 hours`, `Last 7 days`, `Last 30 days`. |

### `/user`

Provides information about the user. *(feature: `core`)*

### `/what-do-you-know-about-me`

See everything Goobster has stored about you (private reply). *(works in DMs; feature: `core`)*

### `/whatsnew`

Shows a summary of recent changes from the changelog *(feature: `core`)*

| Option | Type | Required | Description |
|---|---|---|---|
| `days` | integer | no | Number of days to look back (default: 7) |
| `limit` | integer | no | Maximum number of changes to show (default: 10) |

### `/wrapped`

Server Wrapped - a shareable recap of this server's activity. *(feature: `core`)*

#### `/wrapped show`

Post the Server Wrapped recap for a period

| Option | Type | Required | Description |
|---|---|---|---|
| `period` | text | no | Which period to wrap (default: last month) Choices: `Last month`, `This month`, `This year`. |

#### `/wrapped schedule`

Post last month's Wrapped in this channel on the 1st of every month

#### `/wrapped unschedule`

Stop the monthly Wrapped post

## Voice

### `/setvoice`

Configure the ElevenLabs voice Goobster speaks with in this server or DM *(works in DMs; feature: `voice` + `discord`)*

#### `/setvoice set`

Pick the voice used for this server (or your personal voice in DMs)

| Option | Type | Required | Description |
|---|---|---|---|
| `voice` | text | yes | An ElevenLabs voice name (e.g. "Rachel") or voice ID |

#### `/setvoice clear`

Go back to the server default voice

#### `/setvoice view`

Show the voice currently in use here
