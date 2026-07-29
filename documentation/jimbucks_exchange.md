# The Jimbucks Exchange

Margin, short selling, options (long AND written, including same-day index
contracts and multi-leg spreads), perpetual futures, resting orders, binary
event contracts, real dividends and splits, and the Daily Ballistic Goblin
Wheel - layered on top of the point economy.

Everything here is **off by default**. A server that never runs
`/exchange settings` keeps the plain cash stock game it always had, and every
`/stocks` behaviour is byte-for-byte what it was before.

---

## The one rule everything else follows

**Every point that moves still moves through `economyService.adjust()`.**

The exchange never writes a wallet balance directly and never lets one go
negative. What it adds are *liabilities*, which are tracked beside the wallet
rather than inside it:

| Thing | Where it lives | Why |
|---|---|---|
| Points you own | `economy_wallets` (via `adjust()`) | The wallet is always ≥ 0 |
| Points you owe | `exchange_accounts.marginLoan` | Debt is not a negative balance |
| Units you owe | `short_positions` | A short is an obligation, not cash |
| Contracts you hold | `option_positions` | Fully paid, marked to market |
| Stakes on an event | `prediction_positions` | Settled from the real price |

So the ledger still explains every point in every wallet (the auditor proves
it), and `equity = cash + longs + options − shorts − debt` explains everything
else.

---

## Turning it on

```
/exchange settings margin:true options:true zero_dte:true predictions:true
/exchange settings max_leverage:4 interest_rate:0.08 maintenance:0.25
```

| Setting | Default | What it controls |
|---|---|---|
| `margin` | off | Margin accounts, leverage, borrowing, short selling, written options |
| `options` | off | Calls and puts (long, written, and spreads) |
| `zero_dte` | off | Same-day expiries (requires `options`) |
| `predictions` | off | Binary event contracts |
| `futures` | off | Perpetual futures (isolated margin) |
| `optin_override` | **on** | Group events: everyone with a wallet is in unless they opt out |
| `corporate_actions` | on | Apply real dividends and splits |
| `max_leverage` | 2 | Highest stock-margin tier (capped at 10) |
| `max_perp_leverage` | 10 | Highest perp tier (capped at 50) |
| `funding_rate` | 0.0003 | Daily perp funding on notional |
| `interest_rate` | 0.08 | Annual margin interest, accrued continuously |
| `borrow_fee` | 0.05 | Annual short borrow fee |
| `maintenance` | 0.25 | Equity a long book must keep |
| `short_maintenance` | 0.35 | Equity a short book must keep |
| `grace_minutes` | 60 | How long a margin call may sit before liquidation |

---

## Margin and leverage

```
/margin account type:margin
/margin leverage multiple:3
/margin status
```

- **Buying power** = `(equity − option value) × leverage − current exposure`.
  Long options are excluded from the collateral base because they are not
  marginable, which is also why a contract can never be bought with borrowed
  points.
- A buy larger than the wallet **borrows exactly the shortfall**; the loan is
  credited through the ledger (`margin-borrow`) so the points have a visible
  origin.
- **Interest capitalizes into the loan** rather than debiting the wallet. A
  trader with an empty wallet still owes what they owe.
- `/margin status` shows equity, buying power, the maintenance requirement,
  every position's **liquidation price**, and how far the whole book can move
  before a call.

### Margin calls and forced liquidation

The risk engine marks every account on each tick:

1. Equity below the maintenance requirement raises a **margin call** (DM, event
   log, and a flag on the account).
2. The trader has `grace_minutes` to add points, close positions, or repay.
3. After that the exchange **liquidates largest-exposure-first** until the
   requirement is met, then sweeps the freed cash into the loan.
4. Equity at or below zero skips the grace period entirely — there is nothing
   left to protect.

Two things it will never do: liquidate on a **missing price** (a snapshot with
any unpriced position is skipped), and liquidate more than the shortfall needs
on the first pass.

---

## Short selling

```
/stocks short symbol:TSLA units:10
/stocks cover symbol:TSLA
```

Requires a margin account. The proceeds land in the wallet immediately, the
units owed are marked to market on every snapshot, and the position rents its
borrow at the guild's annual rate until it is covered. You cannot short
something you are long — that is just selling it.

A short's loss is unbounded, so the command says so, and the exchange
force-covers at the liquidation price like any other position.

---

## Options

```
/options expiries
/options chain symbol:SPX
/options quote symbol:SPX type:call strike:6000 expiry:2026-08-21
/options buy symbol:SPX type:call strike:6000 expiry:2026-08-21 contracts:2
/options positions
/options close id:14
```

Long contracts have a known maximum loss — the premium. **Written contracts**
(`/options write`) collect the premium up front and owe the intrinsic value at
settlement (assignment):

- Writing needs a **margin account**, and the open contract consumes a margin
  requirement enforced against buying power before the write fills: the naked
  20% rule (`mark + max(20%·spot − OTM, 10%·spot-or-strike)`), the **strike
  width** when paired into a spread, and **nothing** when a call is covered by
  100 shares per contract.
- At the bell an assigned writer pays even with an empty wallet — the
  shortfall is borrowed onto the margin loan, and the risk engine takes it
  from there. That is exactly how a naked call goes wrong, and the ticket says
  so (`Max loss: UNBOUNDED`).
- Rounding favours the house on both sides: longs settle at the floor,
  writers pay the ceiling.

### Multi-leg spreads

`/options spread symbol:SPCX legs:"buy 100p, sell 76p, buy 130c, sell 155c"
expiry:2026-09-02` prices the whole structure and answers with a **pre-trade
receipt**: every leg with its debit or credit, the net, max gain, max loss,
break-evens, the collateral the written legs require, the pricing timestamp
(clearly simulated), and the 0DTE warning when it applies. Nothing moves until
you re-run with `fire:true`.

- The payoff analysis is exact for any leg set (piecewise-linear at expiry),
  so verticals, straddles, strangles, butterflies, iron condors, **inverse
  iron condors**, and ratio spreads all report honest numbers — including
  `UNBOUNDED` when a wing is naked.
- Execution fills debit legs before credit legs, so written wings land on a
  book that already holds their cover. If a later leg still fails, the filled
  legs are unwound at the same cached quotes: **a spread never half-exists**.

### Where the premiums come from

There is no keyless real option feed (Yahoo's chain endpoint needs an
authenticated crumb), so premiums are **simulated**: Black-Scholes on the
**real** underlying price, with

- volatility estimated from three months of real daily closes (annualized
  realized vol, cached per symbol in `stock_symbols.impliedVol`),
- one vol per expiry with a **term bump** on the front week (what makes 0DTE
  expensive). Deliberately no per-strike smile: a smile that grows faster than
  Black-Scholes decays in strike prices a higher call strike above a lower
  one, which is a free-money vertical arbitrage the moment writing exists -
  one vol per expiry keeps premiums provably monotonic in strike,
- a house bid/ask spread, wider on same-day and cheap contracts.

Every surface that shows a premium says it is simulated. The greeks,
break-even, probability-in-the-money, and probability-of-profit are all real
Black-Scholes quantities computed from those inputs.

Index tickers resolve to the symbols that quote them: `SPX`/`SPXW` → `^GSPC`,
`NDX` → `^NDX`, `RUT` → `^RUT`, `VIX` → `^VIX`, `DJX`/`DJI` → `^DJI`. All
contracts are cash-settled, which is how index options work anyway.

### Settlement

Contracts settle at 20:00 UTC on their expiry date against the underlying's
price at that instant. In the money pays intrinsic value
(`floor(intrinsic × 100 × contracts)`); out of the money pays exactly nothing.
A price outage **defers** settlement to the next tick rather than expiring a
contract worthless on a feed failure.

### The 0DTE gate

Same-day contracts need **two** switches, deliberately:

1. the server's `zero_dte` setting, and
2. the trader's own **Goblin Mode** (`/margin goblin enabled:true`).

The opt-in is recorded in the event log. Every 0DTE purchase still shows the
max loss, the break-even, and the odds before it fills. Accidental nukes are
less fun than intentional ones.

---

## Perpetual futures

```
/futures open symbol:BTC-USD direction:long margin:10000 leverage:10
/futures positions
/futures close id:3
```

Leveraged longs and shorts on any USD symbol — including crypto pairs
(BTC-USD, ETH-USD), which trade around the clock. **Isolated margin,
deliberately**: the points posted ARE the maximum loss. The margin leaves the
wallet at open, unrealized P/L accrues against it, funding rent
(`funding_rate` × notional, daily) erodes it, and the engine liquidates when
the mark crosses the liquidation price — which the ticket shows before you
confirm. A perp can never dig into the rest of the account, and works fine on
a plain cash account for exactly that reason.

## Corporate actions (real ones)

The same keyless chart endpoint that prices everything also reports dividends
and splits (`events=div,splits`), so the exchange applies the real thing:

- **Dividends** — longs are paid `floor(units × amount)`, shorts owe
  `ceil(units × amount)` (borrowed onto the loan when the wallet cannot pay).
  Short a stock through its ex-date and you pay the dividend, like everywhere
  real.
- **Splits** — stock units, short units, option strikes and premiums,
  resting-order prices, event-contract thresholds, and perp entries are all
  adjusted so nobody gains or loses a point from bookkeeping.
- Every event is recorded once globally (`corporate_actions`) and applied
  exactly once. Events seen on a symbol's **first** sweep are recorded without
  being applied — back-paying history to positions that did not exist then
  would invent money.

## Group play: opt-ins and the Ballistic Goblin Wheel

```
/wheel optin [max_percent]     /wheel optout      /wheel status
/wheel participants            /wheel override enabled:<bool>   (Manage Server)
/wheel spin [symbol]           /wheel schedule | unschedule     (Manage Server)
```

The Wheel is the guild's group call-buying ritual: **Wheel 1** picks the
strike target (80%: +1–5%, 19%: +6–10%, 1%: the sacred +20% moonshot),
**Wheel 2** picks what percentage of every rider's wallet deploys (50%: 5%,
30%: 10%, 15%: 20%, 4%: 35%, 1%: 50%), and the exchange buys the nearest
listed call at `spot × (1 + target%)` on the nearest expiry — same-day when
the guild allows it — for every participant. `/wheel schedule` runs it every
weekday at 13:30 UTC (9:30 AM Eastern, the open) through the automations
system.

The consent model, in order of precedence:

1. An **explicit opt-out always wins** — even while the override is on.
2. With no record, the guild's `optin_override` decides. It is **ON by
   default**: everyone with a wallet is in until they say otherwise.
3. With the override off, only explicit opt-ins ride.

`/wheel optin max_percent:5` sets a personal ceiling on what any single spin
may deploy, whatever Wheel 2 says. Participating (or being covered by the
override) stands in for the personal Goblin Mode acknowledgement on the
same-day contract — the ritual is the consent form — but a hand-rolled 0DTE
purchase still requires the personal flag. Every opt-in, opt-out, override
flip, and spin lands in the event log, so "who agreed to this and when" is
always answerable.

## Resting orders

```
/orders place symbol:AAPL side:buy type:limit units:5 limit:180
/orders place symbol:AAPL side:sell type:trailing_stop units:5 trail:10
/orders list
/orders cancel id:7
```

| Type | Triggers when |
|---|---|
| `limit` | Price reaches the limit on the favourable side |
| `stop` | Price moves *against* the position it protects |
| `stop-limit` | Stop triggers, then fills only at the limit or better |
| `trailing stop` | Price retreats `trail%` from its best level since placing |

Orders are intentions, not reservations: nothing is escrowed, and a fill runs
the ordinary trade path with the same wallet and buying-power checks. **A stop
is a trigger, not a promised price** — the engine checks on its tick, so a gap
fills where it lands. An order that can no longer be honoured is `REJECTED`
with the reason attached, visible in `/orders list`.

---

## Event contracts

```
/predict create symbol:RKLB comparator:above threshold:60 resolves:2026-08-07 20:00
/predict markets
/predict buy market:3 side:yes contracts:25
/predict positions
```

Binary markets on a real price at a real time. Each contract costs its price
in points and pays **100** if its side is right, nothing if it is wrong.

- Prices are the **risk-neutral probability** of the event (the same `N(d2)`
  that prices the option chain) plus a fixed house edge, so YES + NO costs 102.
- Settlement is deterministic: the exchange reads the underlying at the
  resolution time. Nobody, including an admin, decides who won.
- Each market caps contracts per trader per side, so one whale cannot own an
  outcome.
- `/predict void` refunds every open contract at cost, for a market that was
  posed badly.

---

## Auditing

This is the part that makes maximum risk legible. Everything below is
read-only.

```
/exchange audit          # the whole market
/exchange account user:@someone
/exchange leaderboard    # ranked by equity, not by wallet size
/exchange events user:@someone
/exchange reconcile      # Manage Server
/exchange tick           # Manage Server: run the engine now
```

**Goobster can do all of it by talking.** `auditAccount` resolves any guild
member by mention, id, username, or display name (and `"you"` means his own
account), then reports positions, live greeks, leverage, buying power,
liquidation levels, realized P/L, and whether the wallet reconciles with the
ledger. `auditExchange` covers the market dashboard, the equity leaderboard,
the engine log, and the integrity checks. Both are in the voice tool subset:

> "Goobster, how deep in is The Data Daddy?"

### Two records, deliberately

- `economy_transactions` — **what** moved. Every point, as always.
- `exchange_events` — **why** it moved. Every automatic action the engine took
  (interest, borrow fees, fills, expiries, settlements, margin calls,
  liquidations) plus every deliberate risk opt-in.

A liquidation is therefore always explainable after the fact: the ledger shows
the sale, the event log shows the margin call that caused it and the reason
recorded at the time.

### Integrity checks

`/exchange reconcile` runs nine invariants. All of them return zero rows on a
healthy exchange:

| Check | Invariant |
|---|---|
| `wallet-ledger-drift` | Every wallet equals the sum of its ledger entries |
| `loan-without-margin` | Only margin accounts carry a loan |
| `short-without-margin` | Only margin accounts hold shorts |
| `long-and-short` | Nobody is long and short the same symbol |
| `unsettled-expiries` | No open contract outlives its settlement time |
| `unsettled-markets` | No event contract outlives its resolution time |
| `orphan-sell-orders` | Every working sell/cover has a position behind it |
| `impossible-positions` | Positions have positive size, non-negative basis |
| `settled-without-payout` | A settled winner recorded its payout |

---

## The risk engine

`services/exchange/riskEngine.js`, started by `index.js`, ticking every five
minutes and idle until a guild actually uses the exchange. Per guild, in order:

1. accrue margin interest and short borrow fees
2. settle contracts past their expiry
3. settle event contracts past their resolution time
4. fill or expire resting orders
5. mark every account, raise margin calls, liquidate the ones out of grace

Notifications are best-effort DMs; a closed DM never blocks a settlement,
because the event log is the durable record. `/exchange tick` runs the same
pass on demand.

---

## Code layout

```
services/exchange/
  optionsMath.js             pure Black-Scholes: price, greeks, IV, probabilities
  marginMath.js              pure margin arithmetic: equity, buying power,
                             liquidation prices/planning, naked-short and
                             option-book requirements, perp state
  spreadMath.js              pure multi-leg payoff analysis + classification
  exchangeConfig.js          per-guild rules (everything risky off by default)
  optionsMarket.js           volatility estimation, expiry calendar, strike
                             ladders, contract quotes, chains
  accountService.js          accounts, borrowing, interest, the risk snapshot
  shortService.js            shorts and borrow fees
  optionsService.js          buy/close/write/buyback/settle, the 0DTE gate
  spreadService.js           multi-leg receipts and atomic-in-effect execution
  perpsService.js            perpetual futures (isolated margin, funding)
  orderService.js            resting orders and their evaluation
  predictionService.js       event contracts
  groupPlayService.js        opt-ins + the override-all consent model
  wheelService.js            the Ballistic Goblin Wheel (injectable RNG)
  corporateActionsService.js real dividends and splits
  riskEngine.js              the tick (the only place that acts unprompted)
  auditService.js            account audits, market dashboard, reconciliation
  exchangeEvents.js          the "why" log
```

The three `*Math` modules are pure and have no I/O, so every number a trader
is shown before taking risk is testable in isolation. `auditService` only
reads. `riskEngine` is the only component that acts without a user asking.

Tests: `tests/exchangeOptionsMath`, `exchangeMargin`, `exchangeOptions`,
`exchangeWriting`, `exchangeSpreads`, `exchangePerps` (incl. corporate
actions), `exchangeWheel`, `exchangeOrders`, `exchangePredictions`,
`exchangeAudit`, `exchangePrivacy`, and `toolsRegistryExchange`.

---

## Privacy

Exchange data is personal financial data and is **deleted outright** by
`/forget-me`: the account, shorts, option positions and fills, orders, event
contracts, perps, Wheel opt-in records, and the user's engine events. A market
they created survives with `createdBy` nulled — the market still settles from
the feed, but their name comes off it. `/what-do-you-know-about-me` reports
the account and every position count, and `auditUser` counts all nine tables
so "zero gaps" stays provable.

---

## What is deliberately not here

- **Real option chains.** Yahoo's chain endpoint requires an authenticated
  crumb, so no keyless source exists; the simulated chain is labelled as such
  everywhere it appears rather than quietly pretending.
- **Extended hours and trading halts.** The quote feed reports regular-session
  prices only, so the game would be inventing them. (Dividends and splits ARE
  here — the feed reports those for real.)
