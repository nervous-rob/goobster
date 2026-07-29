# The Jimbucks Exchange

Margin, short selling, options (including same-day index contracts), resting
orders, and binary event contracts, layered on top of the point economy.

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
| `margin` | off | Margin accounts, leverage, borrowing, short selling |
| `options` | off | Long calls and puts |
| `zero_dte` | off | Same-day expiries (requires `options`) |
| `predictions` | off | Binary event contracts |
| `max_leverage` | 2 | Highest tier a trader may pick (capped at 10) |
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

**Long calls and puts only.** Buying a contract has a known maximum loss — the
premium — which keeps the game's accounting finite. Selling uncovered contracts
has unbounded loss and would need a whole assignment apparatus before it could
be safe, so it is not offered.

### Where the premiums come from

There is no keyless real option feed (Yahoo's chain endpoint needs an
authenticated crumb), so premiums are **simulated**: Black-Scholes on the
**real** underlying price, with

- volatility estimated from three months of real daily closes (annualized
  realized vol, cached per symbol in `stock_symbols.impliedVol`),
- a **volatility smile** (out-of-the-money contracts price richer) and a
  **term bump** on the front week, which is what makes 0DTE expensive,
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
  optionsMath.js       pure Black-Scholes: price, greeks, IV, probabilities
  marginMath.js        pure margin arithmetic: equity, buying power,
                       liquidation prices, liquidation planning
  exchangeConfig.js    per-guild rules (everything risky off by default)
  optionsMarket.js     volatility estimation, expiry calendar, strike ladders,
                       contract quotes, chains
  accountService.js    accounts, borrowing, interest, the risk snapshot
  shortService.js      shorts and borrow fees
  optionsService.js    buy/close/settle contracts, the 0DTE gate
  orderService.js      resting orders and their evaluation
  predictionService.js event contracts
  riskEngine.js        the tick (the only place that acts unprompted)
  auditService.js      account audits, market dashboard, reconciliation
  exchangeEvents.js    the "why" log
```

The two `*Math` modules are pure and have no I/O, so every number a trader is
shown before taking leverage is testable in isolation. `auditService` only
reads. `riskEngine` is the only component that acts without a user asking.

Tests: `tests/exchangeOptionsMath`, `exchangeMargin`, `exchangeOptions`,
`exchangeOrders`, `exchangePredictions`, `exchangeAudit`, `exchangePrivacy`,
and `toolsRegistryExchange`.

---

## Privacy

Exchange data is personal financial data and is **deleted outright** by
`/forget-me`: the account, shorts, option positions and fills, orders, event
contracts, and the user's engine events. A market they created survives with
`createdBy` nulled — the market still settles from the feed, but their name
comes off it. `/what-do-you-know-about-me` reports the account and every
position count, and `auditUser` counts all seven tables so "zero gaps" stays
provable.

---

## What is deliberately not here

- **Selling uncovered contracts** and multi-leg spreads. Buying an option has a
  known max loss; writing one does not, and it needs an assignment engine plus
  real option margin before it is safe.
- **Futures and perpetuals.** They need a funding-rate mechanism and a separate
  liquidation engine.
- **Real option chains.** No keyless source exists; the simulated chain is
  labelled as such everywhere it appears rather than quietly pretending.
- **Extended hours, dividends, splits, and halts.** The quote feed is a daily
  chart endpoint, so the game would be inventing them.
