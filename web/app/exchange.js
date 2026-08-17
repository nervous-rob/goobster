/**
 * The Jimbucks Exchange terminal: the guild-scoped trading pane. Everything
 * here reads and writes through /api/app/exchange/*, which delegates to the
 * same services the slash commands use - so feature gates, margin
 * requirements, and the "every point moves through economyService.adjust"
 * invariant hold for web trades by construction.
 *
 * The exchange is per-guild (wallets, positions, and feature flags all key on
 * guildId), so this pane picks a server first and the DM scope never appears.
 */
import { api } from './api.js';

const guildSelect = document.getElementById('exchange-guild-select');
const tabs = document.getElementById('exchange-tabs');
const optionsTabBtn = document.getElementById('exchange-options-tab-btn');
const refreshBtn = document.getElementById('exchange-refresh-btn');
const panes = {
    portfolio: document.getElementById('xtab-portfolio'),
    trade: document.getElementById('xtab-trade'),
    options: document.getElementById('xtab-options'),
    orders: document.getElementById('xtab-orders'),
    leaderboard: document.getElementById('xtab-leaderboard')
};

const HISTORY_RANGES = ['1mo', '3mo', '6mo', '1y'];
// Which server you were trading in is worth remembering (the theme
// precedent): a member of a dozen guilds should not have to re-pick one
// every visit just because the cache happened to order them differently.
const GUILD_KEY = 'goobster-exchange-guild';

let guilds = [];
let currentGuild = null;
let currentTab = 'portfolio';
let features = {};
let currencyName = 'points';
let showToast = () => {};
let confirmDialog = async () => false;
let initialized = false;

// Per-tab working state (reset when the server changes)
let tradeSymbol = '';
let tradeView = null;
let tradeHistory = null;
let historyRange = '3mo';
let chainSymbol = '';
let chainExpiry = null;
let chainContracts = 1;

function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

function escapeText(text) {
    const span = document.createElement('span');
    span.textContent = String(text ?? '');
    return span.innerHTML;
}

/** Points are the currency: whole numbers, thousands-separated. */
function points(value) {
    if (value === null || value === undefined) return '&mdash;';
    return Math.round(value).toLocaleString();
}

/** Prices and premiums are dollars (1 point = $1), shown to 2dp. */
function usd(value) {
    if (value === null || value === undefined) return '&mdash;';
    return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function units(value) {
    if (value === null || value === undefined) return '&mdash;';
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/** A signed P/L cell that colours itself. */
function plCell(value) {
    if (value === null || value === undefined) return '<span class="x-pl">&mdash;</span>';
    const rounded = Math.round(value);
    const cls = rounded > 0 ? 'up' : rounded < 0 ? 'down' : '';
    const sign = rounded > 0 ? '+' : '';
    return `<span class="x-pl ${cls}">${sign}${rounded.toLocaleString()}</span>`;
}

function statCard(label, value, sub = '') {
    return `
      <div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
        ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
      </div>`;
}

function whenLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Show the loading placeholder. Pass `keepCurrent` when re-fetching something
 * already on screen (after a trade, or on a range/expiry switch): blanking a
 * populated tab collapses it to a bare line for two round-trips, which reflows
 * everything and buries the toast reporting what the trade just did.
 */
function loading(pane, { keepCurrent = false } = {}) {
    if (keepCurrent && pane.childElementCount > 0) return;
    pane.innerHTML = '<div class="empty">Loading&hellip;</div>';
}

function failed(pane, error) {
    pane.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
    showToast(error.message, true);
}

/* ---------- portfolio ---------- */

function positionsCard(title, rows, hint = '') {
    if (rows.length === 0) return null;
    const card = el(`<div class="x-block"><div class="section-title">${title}</div>
      ${hint ? `<div class="hint">${hint}</div>` : ''}
      <div class="list-card x-table"></div></div>`);
    const table = card.querySelector('.x-table');
    for (const row of rows) table.appendChild(row);
    return card;
}

function optionLabel(position) {
    const type = position.optionType === 'CALL' ? 'C' : 'P';
    return `${position.underlying} ${position.strike}${type} ${position.expiry}`;
}

function renderPortfolio(overview) {
    const { audit } = overview;
    const snap = audit.snapshot;
    const pane = panes.portfolio;
    pane.replaceChildren();

    // Headline balance sheet
    pane.appendChild(el(`
      <div class="stat-grid">
        ${statCard('Equity', points(snap.equity), `cash + positions &minus; debt`)}
        ${statCard('Cash', points(snap.cash), escapeText(currencyName))}
        ${statCard('Buying power', points(snap.buyingPower), `${snap.account.accountType} account`)}
        ${statCard('Exposure', points(snap.exposure),
        snap.leverageUsed ? `${snap.leverageUsed.toFixed(2)}&times; equity` : 'no positions')}
      </div>`));

    // Margin state only matters once there is a loan or a margin account
    if (snap.debt > 0 || snap.account.accountType === 'MARGIN') {
        pane.appendChild(el(`
          <div class="stat-grid">
            ${statCard('Debt', points(snap.debt),
            `loan ${points(snap.account.marginLoan)} + interest ${points(snap.account.accruedInterest)}`)}
            ${statCard('Maintenance', points(snap.maintenance), 'required equity')}
            ${statCard('Excess liquidity', points(snap.excessLiquidity),
            snap.marginCall ? 'MARGIN CALL' : 'above requirement')}
            ${statCard('Leverage tier', `${snap.account.leverage}&times;`,
            snap.account.goblinMode ? 'Goblin Mode on' : 'Goblin Mode off')}
          </div>`));
    }

    if (snap.marginCall) {
        pane.appendChild(el(`<div class="x-alert danger">⚠ Margin call &mdash; equity
          (${points(snap.equity)}) is below the maintenance requirement (${points(snap.maintenance)}).
          The risk engine liquidates after the grace period.</div>`));
    }
    if (snap.pricingGaps > 0) {
        pane.appendChild(el(`<div class="x-alert">${snap.pricingGaps} position(s) could not be priced
          right now &mdash; the engine defers rather than guessing, so nothing settles or liquidates
          on a feed outage.</div>`));
    }
    for (const risk of audit.risks || []) {
        pane.appendChild(el(`<div class="x-alert">${escapeText(risk)}</div>`));
    }

    // Positions
    const longs = positionsCard('Stocks', snap.longs.map(position => el(`
      <div class="list-row">
        <div class="row-body"><code>${escapeText(position.symbol)}</code>
          <div class="row-meta">${units(position.units)} units &middot; cost ${points(position.costBasis)}
            &middot; ${usd(position.price)}${position.stale ? ' (stale)' : ''}</div>
        </div>
        <div class="x-numbers"><span>${points(position.value)}</span>${plCell(position.profitLoss)}</div>
      </div>`)));
    if (longs) pane.appendChild(longs);

    const shorts = positionsCard('Shorts', snap.shorts.map(position => el(`
      <div class="list-row">
        <div class="row-body"><code>${escapeText(position.symbol)}</code>
          <span class="badge">SHORT</span>
          <div class="row-meta">${units(position.units)} units owed &middot; credit ${points(position.proceeds)}
            &middot; fees ${points(position.borrowFeeAccrued)}</div>
        </div>
        <div class="x-numbers"><span>${points(position.value)} to cover</span>${plCell(position.profitLoss)}</div>
      </div>`)), 'Shorts owe units, not points - the buy-back cost is the liability.');
    if (shorts) pane.appendChild(shorts);

    const options = positionsCard('Options', snap.options.map(position => el(`
      <div class="list-row">
        <div class="row-body"><code>${escapeText(optionLabel(position))}</code>
          <span class="badge ${position.side === 'SHORT' ? 'warn' : ''}">${escapeText(position.side)}</span>
          ${position.zeroDte ? '<span class="badge danger">0DTE</span>' : ''}
          <div class="row-meta">${position.contracts} contract(s) &middot; cost ${points(position.costBasis)}
            &middot; mark ${usd(position.mark)}
            ${position.daysToExpiry !== null ? `&middot; ${position.daysToExpiry}d left` : ''}
            ${position.greeks ? `&middot; &delta; ${position.greeks.delta.toFixed(2)}` : ''}</div>
        </div>
        <div class="x-numbers"><span>${points(position.value)}</span>${plCell(position.profitLoss)}</div>
      </div>`)), 'Premiums are simulated (Black-Scholes on the real underlying), never a real chain.');
    if (options) pane.appendChild(options);

    const perps = positionsCard('Perpetual futures', snap.perps.map(position => el(`
      <div class="list-row">
        <div class="row-body"><code>${escapeText(position.symbol)}</code>
          <span class="badge">${escapeText(position.direction)} ${position.leverage}&times;</span>
          <div class="row-meta">${units(position.units)} units &middot; entry ${usd(position.entryPrice)}
            &middot; margin ${points(position.margin)}
            &middot; liq ${usd(position.liquidationPrice)}
            &middot; funding ${points(position.fundingAccrued)}</div>
        </div>
        <div class="x-numbers"><span>${points(position.value)}</span>${plCell(position.unrealized)}</div>
      </div>`)), 'Isolated margin: the posted margin is the maximum loss.');
    if (perps) pane.appendChild(perps);

    const empty = snap.longs.length === 0 && snap.shorts.length === 0
        && snap.options.length === 0 && snap.perps.length === 0;
    if (empty) {
        pane.appendChild(el(`<div class="empty">No open positions &mdash; head to
          <strong>Trade</strong> to buy your first ${escapeText(currencyName)} worth of stock.</div>`));
    }

    // Liquidation levels are the point of separating the margin math out
    if (snap.liquidationLevels?.length > 0) {
        const card = el('<div class="x-block"><div class="section-title">Liquidation levels</div><div class="list-card x-table"></div></div>');
        const table = card.querySelector('.x-table');
        for (const level of snap.liquidationLevels) {
            table.appendChild(el(`
              <div class="list-row">
                <div class="row-body"><code>${escapeText(level.symbol)}</code>
                  <span class="badge">${escapeText(level.direction)}</span></div>
                <div class="x-numbers"><span>${usd(level.price)}</span></div>
              </div>`));
        }
        pane.appendChild(card);
    }

    // Realized results + the ledger reconciliation, the audit's whole point
    const realized = audit.realized;
    pane.appendChild(el(`
      <div class="x-block">
        <div class="section-title">Realized</div>
        <div class="stat-grid">
          ${statCard('Options', plCell(realized.options), `${realized.optionsClosed} closed`)}
          ${statCard('Shorts', plCell(realized.shorts), `${realized.shortCovers} covers`)}
          ${statCard('Futures', plCell(realized.perps),
        `${realized.perpsClosed} closed, ${realized.perpsLiquidated} liquidated`)}
          ${statCard('Event contracts', plCell(realized.predictions), `${realized.predictionsSettled} settled`)}
          ${statCard('Dividends', plCell(realized.dividendsNet), 'net of short payouts')}
          ${statCard('Financing', plCell(realized.financingPaid), 'interest + borrow fees')}
        </div>
      </div>`));

    pane.appendChild(el(`
      <div class="x-block">
        <div class="section-title">Wallet ledger</div>
        <div class="hint">${audit.ledger.reconciles
        ? '✓ Every point in this wallet is explained by the ledger.'
        : '⚠ The ledger and the wallet disagree - run /exchange reconcile.'}</div>
      </div>`));
    if (audit.ledger.recent?.length > 0) {
        const card = el('<div class="list-card x-table"></div>');
        for (const entry of audit.ledger.recent) {
            card.appendChild(el(`
              <div class="list-row">
                <div class="row-body">${escapeText(entry.type)}
                  <div class="row-meta">${escapeText(whenLabel(entry.createdAt))}</div>
                </div>
                <div class="x-numbers">${plCell(entry.amount)}<span>&rarr; ${points(entry.balanceAfter)}</span></div>
              </div>`));
        }
        pane.appendChild(card);
    }

    // The engine's "why" log - the durable record behind every auto action
    if (audit.events?.length > 0) {
        const card = el('<div class="x-block"><div class="section-title">Engine events</div><div class="list-card x-table"></div></div>');
        const table = card.querySelector('.x-table');
        for (const event of audit.events) {
            table.appendChild(el(`
              <div class="list-row">
                <div class="row-body"><code>${escapeText(event.eventType)}</code>
                  ${event.symbol ? `<span class="badge">${escapeText(event.symbol)}</span>` : ''}
                  <div class="row-meta">${escapeText(whenLabel(event.createdAt))}</div>
                </div>
                <div class="x-numbers">${event.amount === null ? '' : plCell(event.amount)}</div>
              </div>`));
        }
        pane.appendChild(card);
    }

    pane.appendChild(el(`<div class="hint" style="margin-top:10px">Priced
      ${escapeText(whenLabel(audit.asOf))}. Advanced instruments are enabled per server with
      <code>/exchange settings</code>; option premiums are always simulated.</div>`));
}

/* ---------- trade ---------- */

/** Dependency-free close-price line chart (the usage.js canvas pattern). */
function drawHistory(canvas, series) {
    const styles = getComputedStyle(document.body);
    const first = series[0]?.close ?? 0;
    const last = series[series.length - 1]?.close ?? 0;
    const line = (last >= first
        ? styles.getPropertyValue('--ok') : styles.getPropertyValue('--danger')).trim() || '#59d18c';
    const grid = styles.getPropertyValue('--border').trim() || '#2a2f40';
    const text = styles.getPropertyValue('--text-dim').trim() || '#9aa3b8';

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 200;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const pad = { left: 52, right: 8, top: 10, bottom: 20 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const closes = series.map(p => p.close);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const x = i => pad.left + (plotW * i) / Math.max(1, series.length - 1);
    const y = value => pad.top + plotH - (plotH * (value - min)) / span;

    ctx.strokeStyle = grid;
    ctx.fillStyle = text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
        const gy = pad.top + plotH - (plotH * i) / 3;
        ctx.beginPath();
        ctx.moveTo(pad.left, gy);
        ctx.lineTo(width - pad.right, gy);
        ctx.stroke();
        ctx.fillText(`$${(min + (span * i) / 3).toFixed(2)}`, 4, gy + 4);
    }

    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((point, i) => (i === 0 ? ctx.moveTo(x(i), y(point.close)) : ctx.lineTo(x(i), y(point.close))));
    ctx.stroke();

    ctx.fillStyle = text;
    ctx.textAlign = 'left';
    ctx.fillText(series[0]?.date || '', pad.left, height - 5);
    ctx.textAlign = 'right';
    ctx.fillText(series[series.length - 1]?.date || '', width - pad.right, height - 5);
}

function renderTrade() {
    const pane = panes.trade;
    pane.replaceChildren();

    pane.appendChild(el(`
      <form id="x-symbol-form" class="x-search-row">
        <input id="x-symbol-input" class="input" type="text" maxlength="40" autocomplete="off"
          placeholder="Symbol or company (AAPL, tesla&hellip;)" value="${escapeText(tradeSymbol)}"
          aria-label="Symbol or company name">
        <button class="btn primary" type="submit">Quote</button>
        <button id="x-search-btn" class="btn" type="button">Search</button>
      </form>
      `));
    const results = el('<div id="x-search-results"></div>');
    pane.appendChild(results);
    const detail = el('<div id="x-quote-detail"></div>');
    pane.appendChild(detail);

    if (!tradeView) {
        detail.appendChild(el(`<div class="empty">Look up a symbol to trade it.
          Buying debits points at 1 point = $1; only USD-quoted symbols are tradable.</div>`));
        return;
    }

    const { quote, holding, shortPosition, balance } = tradeView;
    const canShort = features.marginEnabled;

    detail.appendChild(el(`
      <div class="x-block">
        <div class="x-quote-head">
          <div>
            <div class="x-quote-symbol"><code>${escapeText(quote.symbol)}</code>
              ${quote.stale ? '<span class="badge warn">stale</span>' : ''}</div>
            <div class="hint">${escapeText(quote.name || '')}</div>
          </div>
          <div class="x-quote-price">${usd(quote.price)}</div>
        </div>
        <div class="hint">Priced ${escapeText(whenLabel(quote.asOf))} &middot;
          wallet ${points(balance)} ${escapeText(currencyName)}</div>
      </div>`));

    // History chart
    const chartCard = el(`
      <div class="x-block">
        <div class="x-chart-head">
          <div class="section-title" style="margin:0">Price history</div>
          <div id="x-range" class="segment" role="group" aria-label="History range">
            ${HISTORY_RANGES.map(range =>
        `<button class="segment-btn ${range === historyRange ? 'active' : ''}" data-range="${range}">${range}</button>`).join('')}
          </div>
        </div>
        <div class="list-card x-chart-card">
          <canvas class="x-chart" role="img" aria-label="Daily closing price chart"></canvas>
        </div>
      </div>`);
    detail.appendChild(chartCard);
    const canvas = chartCard.querySelector('canvas');
    if (tradeHistory?.points?.length > 1) {
        requestAnimationFrame(() => drawHistory(canvas, tradeHistory.points));
    } else {
        chartCard.querySelector('.x-chart-card').replaceChildren(
            el('<div class="empty">No history available for this symbol.</div>'));
    }

    // Current exposure to this symbol
    if (holding || shortPosition) {
        const card = el('<div class="x-block"><div class="section-title">Your position</div><div class="list-card x-table"></div></div>');
        const table = card.querySelector('.x-table');
        if (holding) {
            table.appendChild(el(`
              <div class="list-row">
                <div class="row-body"><span class="badge">LONG</span>
                  <div class="row-meta">${units(holding.units)} units &middot; cost ${points(holding.costBasis)}</div>
                </div>
                <div class="x-numbers">${plCell(holding.units * quote.price - holding.costBasis)}</div>
              </div>`));
        }
        if (shortPosition) {
            table.appendChild(el(`
              <div class="list-row">
                <div class="row-body"><span class="badge warn">SHORT</span>
                  <div class="row-meta">${units(shortPosition.units)} units owed &middot;
                    credit ${points(shortPosition.proceeds)} &middot;
                    fees ${points(shortPosition.borrowFeeAccrued)}</div>
                </div>
                <div class="x-numbers">${plCell(shortPosition.proceeds - shortPosition.units * quote.price)}</div>
              </div>`));
        }
        detail.appendChild(card);
    }

    // Market order form
    detail.appendChild(el(`
      <div class="x-block">
        <div class="section-title">Market order</div>
        <form id="x-trade-form" class="x-form">
          <div class="field">
            <label for="x-trade-units">Units</label>
            <input id="x-trade-units" class="input" type="number" min="0" step="0.0001"
              placeholder="units (blank = whole position on sell/cover)">
          </div>
          <div class="x-btn-row">
            <button class="btn primary" type="submit" data-side="buy">Buy</button>
            <button class="btn" type="submit" data-side="sell">Sell</button>
            <button class="btn" type="submit" data-side="short"
              ${canShort ? '' : 'disabled title="Margin is off for this server"'}>Short</button>
            <button class="btn" type="submit" data-side="cover"
              ${canShort ? '' : 'disabled title="Margin is off for this server"'}>Cover</button>
          </div>
          <div class="hint">Buys round the point cost up and sells round it down &mdash; rounding
            always favours the house.${canShort ? '' : ' Shorting needs margin enabled by an admin.'}</div>
        </form>
      </div>`));
}

async function loadQuote(symbol, { keepCurrent = false } = {}) {
    const detail = document.getElementById('x-quote-detail');
    if (detail) loading(detail, { keepCurrent });
    try {
        tradeView = await api.exchangeQuote(currentGuild, symbol);
        tradeSymbol = tradeView.quote.symbol;
        currencyName = tradeView.currencyName || currencyName;
        try {
            tradeHistory = await api.exchangeHistory(currentGuild, tradeSymbol, historyRange);
        } catch {
            tradeHistory = null; // a chartless quote is still tradable
        }
        renderTrade();
    } catch (error) {
        tradeView = null;
        renderTrade();
        showToast(error.message, true);
    }
}

async function runTrade(side) {
    const input = document.getElementById('x-trade-units');
    const raw = input.value.trim();
    if (!raw && (side === 'buy' || side === 'short')) {
        showToast('Enter how many units to trade.', true);
        return;
    }
    if (side === 'short' && !await confirmDialog(
        `Short ${raw} units of ${tradeSymbol}? A short owes units, not points - ` +
        'losses are unbounded and borrow fees accrue until you cover.')) return;
    try {
        const result = await api.exchangeTrade(currentGuild, {
            side, symbol: tradeSymbol, units: raw === '' ? null : Number(raw)
        });
        const moved = result.cost ?? result.proceeds ?? 0;
        showToast(`${side} ${units(result.units)} ${result.symbol} @ ${usd(result.price)} ` +
            `(${Math.round(moved).toLocaleString()} ${currencyName}) - balance ${Math.round(result.balance).toLocaleString()}`);
        input.value = '';
        await loadQuote(tradeSymbol, { keepCurrent: true });
    } catch (error) {
        showToast(error.message, true);
    }
}

async function runSearch() {
    const query = document.getElementById('x-symbol-input').value.trim();
    const results = document.getElementById('x-search-results');
    if (!query) return;
    results.replaceChildren(el('<div class="empty">Searching&hellip;</div>'));
    try {
        const { results: matches } = await api.exchangeSearch(currentGuild, query);
        if (matches.length === 0) {
            results.replaceChildren(el('<div class="empty">No matches.</div>'));
            return;
        }
        const card = el('<div class="list-card x-table"></div>');
        for (const match of matches) {
            card.appendChild(el(`
              <div class="list-row x-result" data-symbol="${escapeText(match.symbol)}" role="button" tabindex="0">
                <div class="row-body"><code>${escapeText(match.symbol)}</code>
                  <div class="row-meta">${escapeText(match.name || '')}
                    ${match.exchange ? `&middot; ${escapeText(match.exchange)}` : ''}</div>
                </div>
              </div>`));
        }
        results.replaceChildren(card);
    } catch (error) {
        results.replaceChildren(el(`<div class="empty">${escapeText(error.message)}</div>`));
    }
}

/* ---------- options chain ---------- */

function contractCell(contract, side) {
    return `
      <div class="x-chain-side">
        <div class="x-chain-prices">
          <span title="bid">${usd(contract.bid)}</span>
          <span class="x-chain-mid" title="mid">${usd(contract.mid)}</span>
          <span title="ask">${usd(contract.ask)}</span>
        </div>
        <div class="row-meta">&delta; ${contract.greeks.delta.toFixed(2)}
          &middot; IV ${(contract.iv * 100).toFixed(0)}%
          &middot; ITM ${(contract.probabilityItm * 100).toFixed(0)}%</div>
        <div class="x-btn-row">
          <button class="btn small x-chain-act" data-action="buy" data-type="${side}"
            data-strike="${contract.strike}">Buy ${points(contract.costPerContract)}</button>
          <button class="btn small subtle x-chain-act" data-action="write" data-type="${side}"
            data-strike="${contract.strike}">Write +${points(contract.creditPerContract)}</button>
        </div>
      </div>`;
}

function renderChain(chain) {
    const pane = panes.options;
    pane.replaceChildren();

    pane.appendChild(el(`
      <form id="x-chain-form" class="x-search-row">
        <input id="x-chain-symbol" class="input" type="text" maxlength="40" autocomplete="off"
          placeholder="Underlying (AAPL, SPX&hellip;)" value="${escapeText(chainSymbol)}"
          aria-label="Option underlying">
        <button class="btn primary" type="submit">Load chain</button>
      </form>`));

    if (!chain) {
        pane.appendChild(el(`<div class="empty">Load an underlying to see its chain.
          Premiums are simulated with Black-Scholes on the real underlying price &mdash;
          there is no keyless real option feed.</div>`));
        return;
    }

    pane.appendChild(el(`
      <div class="x-block">
        <div class="x-quote-head">
          <div>
            <div class="x-quote-symbol"><code>${escapeText(chain.label)}</code>
              ${chain.stale ? '<span class="badge warn">stale</span>' : ''}
              ${chain.zeroDte ? '<span class="badge danger">0DTE</span>' : ''}</div>
            <div class="hint">${escapeText(chain.name || '')}</div>
          </div>
          <div class="x-quote-price">${usd(chain.spot)}</div>
        </div>
        <div id="x-expiries" class="segment x-expiries" role="group" aria-label="Expiry">
          ${chain.expiries.map(expiry => `
            <button class="segment-btn ${expiry.expiry === chain.expiry ? 'active' : ''}"
              data-expiry="${escapeText(expiry.expiry)}">${escapeText(expiry.expiry)}
              <span class="row-meta">${escapeText(expiry.label)}</span></button>`).join('')}
        </div>
        <div class="x-contracts-row">
          <label for="x-contracts">Contracts per trade</label>
          <input id="x-contracts" class="input" type="number" min="1" step="1" value="${chainContracts}">
        </div>
      </div>`));

    const table = el(`
      <div class="x-block">
        <div class="x-chain-head"><div>Calls</div><div>Strike</div><div>Puts</div></div>
        <div class="list-card x-chain"></div>
      </div>`);
    const body = table.querySelector('.x-chain');
    for (const row of chain.rows) {
        const atm = Math.abs(row.strike - chain.spot) < (chain.rows[1]?.strike - chain.rows[0]?.strike || 1) / 2;
        body.appendChild(el(`
          <div class="x-chain-row${atm ? ' atm' : ''}">
            ${contractCell(row.call, 'CALL')}
            <div class="x-chain-strike">${row.strike}</div>
            ${contractCell(row.put, 'PUT')}
          </div>`));
    }
    table.querySelector('.x-chain').dataset.expiry = chain.expiry;
    pane.appendChild(table);

    pane.appendChild(el(`<div class="hint" style="margin-top:10px">Buying is cash-paid with a known
      maximum loss (the premium). Writing needs a MARGIN account and consumes a real margin
      requirement. Contracts are cash-settled at 20:00 UTC on the expiry date.
      ${chain.zeroDte ? ' Same-day contracts also need Goblin Mode (<code>/margin goblin</code>).' : ''}</div>`));
}

async function loadChain(symbol, expiry = null, { keepCurrent = false } = {}) {
    const pane = panes.options;
    loading(pane, { keepCurrent });
    try {
        const chain = await api.exchangeChain(currentGuild, symbol, expiry);
        chainSymbol = chain.underlyingAlias || chain.underlying;
        chainExpiry = chain.expiry;
        renderChain(chain);
    } catch (error) {
        chainExpiry = null;
        renderChain(null);
        showToast(error.message, true);
    }
}

async function tradeContract({ action, optionType, strike }) {
    const contracts = Number(document.getElementById('x-contracts')?.value);
    if (!Number.isFinite(contracts) || contracts <= 0) {
        showToast('Contracts must be a positive number.', true);
        return;
    }
    chainContracts = contracts;
    if (action === 'write' && !await confirmDialog(
        `Write ${contracts} ${chainSymbol} ${strike} ${optionType}? Writing collects the premium ` +
        'now but a written call has unbounded loss, and the margin requirement is held against ' +
        'your buying power until you buy it back or it settles.')) return;
    try {
        const result = await api.exchangeTradeOption(currentGuild, {
            action, symbol: chainSymbol, optionType, strike, expiry: chainExpiry, contracts
        });
        const moved = result.cost ?? result.credit ?? 0;
        showToast(`${action} ${result.contracts} contract(s) for ` +
            `${Math.round(moved).toLocaleString()} ${currencyName} - balance ` +
            `${Math.round(result.balance).toLocaleString()}`);
        await loadChain(chainSymbol, chainExpiry, { keepCurrent: true });
    } catch (error) {
        showToast(error.message, true);
    }
}

/* ---------- resting orders ---------- */

function renderOrders(orders) {
    const pane = panes.orders;
    pane.replaceChildren();

    pane.appendChild(el(`
      <div class="x-block">
        <div class="section-title">Place a resting order</div>
        <form id="x-order-form" class="x-form">
          <div class="x-form-grid">
            <div class="field">
              <label for="x-order-symbol">Symbol</label>
              <input id="x-order-symbol" class="input" type="text" maxlength="20" placeholder="AAPL">
            </div>
            <div class="field">
              <label for="x-order-side">Side</label>
              <select id="x-order-side" class="select">
                <option value="BUY">Buy</option>
                <option value="SELL">Sell</option>
                <option value="SHORT">Short</option>
                <option value="COVER">Cover</option>
              </select>
            </div>
            <div class="field">
              <label for="x-order-type">Type</label>
              <select id="x-order-type" class="select">
                <option value="LIMIT">Limit</option>
                <option value="STOP">Stop</option>
                <option value="STOP_LIMIT">Stop limit</option>
                <option value="TRAILING_STOP">Trailing stop</option>
              </select>
            </div>
            <div class="field">
              <label for="x-order-units">Units</label>
              <input id="x-order-units" class="input" type="number" min="0" step="0.0001" placeholder="1">
            </div>
            <div class="field">
              <label for="x-order-limit">Limit price</label>
              <input id="x-order-limit" class="input" type="number" min="0" step="0.01" placeholder="optional">
            </div>
            <div class="field">
              <label for="x-order-stop">Stop price</label>
              <input id="x-order-stop" class="input" type="number" min="0" step="0.01" placeholder="optional">
            </div>
            <div class="field">
              <label for="x-order-trail">Trail %</label>
              <input id="x-order-trail" class="input" type="number" min="0" step="0.1" placeholder="optional">
            </div>
          </div>
          <div class="x-btn-row"><button class="btn primary" type="submit">Place order</button></div>
          <div class="hint">The risk engine evaluates resting orders every 5 minutes against the
            live quote - it is not a continuous matching engine.</div>
        </form>
      </div>`));

    if (orders.length === 0) {
        pane.appendChild(el('<div class="empty">No orders yet.</div>'));
        return;
    }

    const card = el('<div class="x-block"><div class="section-title">Orders</div><div class="list-card x-table"></div></div>');
    const table = card.querySelector('.x-table');
    for (const order of orders) {
        // Only an un-filled order can still be pulled: OPEN is resting,
        // TRIGGERED is a stop whose trigger fired but has not filled yet.
        const working = order.status === 'OPEN' || order.status === 'TRIGGERED';
        table.appendChild(el(`
          <div class="list-row">
            <div class="row-body">
              <code>${escapeText(order.symbol)}</code>
              <span class="badge">${escapeText(order.side)} ${escapeText(order.orderType)}</span>
              <span class="badge ${working ? '' : 'warn'}">${escapeText(order.status)}</span>
              <div class="row-meta">${units(order.units)} units
                ${order.limitPrice ? `&middot; limit ${usd(order.limitPrice)}` : ''}
                ${order.stopPrice ? `&middot; stop ${usd(order.stopPrice)}` : ''}
                ${order.trailPercent ? `&middot; trail ${order.trailPercent}%` : ''}
                ${order.filledPrice ? `&middot; filled ${usd(order.filledPrice)}` : ''}
                ${order.note ? `&middot; ${escapeText(order.note)}` : ''}
              </div>
            </div>
            <div class="x-numbers">
              ${working ? `<button class="btn small danger x-cancel-order" data-id="${order.id}">Cancel</button>` : ''}
            </div>
          </div>`));
    }
    pane.appendChild(card);
}

async function loadOrders({ keepCurrent = false } = {}) {
    loading(panes.orders, { keepCurrent });
    try {
        const { orders } = await api.exchangeOrders(currentGuild);
        renderOrders(orders);
    } catch (error) {
        failed(panes.orders, error);
    }
}

async function placeOrder() {
    const value = id => document.getElementById(id).value.trim();
    const number = id => (value(id) === '' ? null : Number(value(id)));
    try {
        const { order, triggerHint } = await api.exchangePlaceOrder(currentGuild, {
            symbol: value('x-order-symbol'),
            side: value('x-order-side'),
            orderType: value('x-order-type'),
            units: number('x-order-units'),
            limitPrice: number('x-order-limit'),
            stopPrice: number('x-order-stop'),
            trailPercent: number('x-order-trail')
        });
        showToast(`Order #${order.id} working - ${triggerHint || 'queued'}`);
        await loadOrders({ keepCurrent: true });
    } catch (error) {
        showToast(error.message, true);
    }
}

/* ---------- leaderboard ---------- */

function renderLeaderboard(board) {
    const pane = panes.leaderboard;
    pane.replaceChildren();
    if (board.rows.length === 0) {
        pane.appendChild(el('<div class="empty">Nobody is trading here yet.</div>'));
        return;
    }
    const card = el('<div class="list-card x-table"></div>');
    board.rows.forEach((row, index) => {
        card.appendChild(el(`
          <div class="list-row">
            <div class="row-body">
              <span class="x-rank">#${index + 1}</span>
              ${escapeText(row.name || row.userId)}
              ${row.isBot ? '<span class="badge">bot</span>' : ''}
              <span class="badge">${escapeText(row.accountType)}</span>
              ${row.marginCall ? '<span class="badge danger">margin call</span>' : ''}
              <div class="row-meta">cash ${points(row.cash)} &middot; exposure ${points(row.exposure)}
                &middot; debt ${points(row.debt)}</div>
            </div>
            <div class="x-numbers"><span class="x-equity">${points(row.equity)}</span></div>
          </div>`));
    });
    pane.appendChild(card);
    pane.appendChild(el(`<div class="hint" style="margin-top:10px">Ranked by <strong>equity</strong>
      (${escapeText(board.currencyName)}), so a wallet full of borrowed points is not a big
      account.</div>`));
}

/* ---------- tab plumbing ---------- */

/**
 * The overview drives the currency name and feature flags every other tab
 * needs, so it is fetched whenever the server changes.
 */
async function loadOverview() {
    loading(panes.portfolio);
    try {
        const overview = await api.exchangeOverview(currentGuild);
        features = overview.features || {};
        currencyName = overview.currencyName || 'points';
        optionsTabBtn.classList.toggle('hidden', !features.optionsEnabled);
        if (currentTab === 'options' && !features.optionsEnabled) setTab('portfolio');
        renderPortfolio(overview);
        return true;
    } catch (error) {
        failed(panes.portfolio, error);
        return false;
    }
}

async function renderTab() {
    if (!currentGuild) return;
    if (currentTab === 'portfolio') {
        await loadOverview();
        return;
    }
    // Every other tab needs the feature flags and currency name first
    if (!currencyName || Object.keys(features).length === 0) await loadOverview();
    if (currentTab === 'trade') {
        renderTrade();
        if (tradeSymbol && !tradeView) await loadQuote(tradeSymbol);
    } else if (currentTab === 'options') {
        if (chainSymbol) await loadChain(chainSymbol, chainExpiry);
        else renderChain(null);
    } else if (currentTab === 'orders') {
        await loadOrders();
    } else if (currentTab === 'leaderboard') {
        loading(panes.leaderboard);
        try {
            renderLeaderboard(await api.exchangeLeaderboard(currentGuild));
        } catch (error) {
            failed(panes.leaderboard, error);
        }
    }
}

function setTab(name) {
    currentTab = name;
    for (const btn of tabs.querySelectorAll('.segment-btn')) {
        btn.classList.toggle('active', btn.dataset.xtab === name);
    }
    for (const [key, pane] of Object.entries(panes)) {
        pane.classList.toggle('hidden', key !== name);
    }
}

function wire() {
    guildSelect.addEventListener('change', () => {
        currentGuild = guildSelect.value;
        try { localStorage.setItem(GUILD_KEY, currentGuild); } catch { /* private mode */ }
        // Positions, quotes, and chains are all per-guild - start clean
        features = {};
        tradeView = null;
        tradeHistory = null;
        chainExpiry = null;
        renderTab();
    });

    tabs.addEventListener('click', (event) => {
        const btn = event.target.closest('.segment-btn');
        if (!btn) return;
        setTab(btn.dataset.xtab);
        renderTab();
    });

    refreshBtn.addEventListener('click', () => renderTab());

    // Trade tab: search, quote, range switch, and the market order buttons
    panes.trade.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (event.target.id === 'x-symbol-form') {
            const symbol = document.getElementById('x-symbol-input').value.trim();
            if (symbol) await loadQuote(symbol);
        } else if (event.target.id === 'x-trade-form') {
            await runTrade(event.submitter?.dataset.side || 'buy');
        }
    });

    panes.trade.addEventListener('click', async (event) => {
        if (event.target.id === 'x-search-btn') {
            await runSearch();
            return;
        }
        const result = event.target.closest('.x-result');
        if (result) {
            await loadQuote(result.dataset.symbol);
            return;
        }
        const range = event.target.closest('#x-range .segment-btn');
        if (range) {
            historyRange = range.dataset.range;
            await loadQuote(tradeSymbol, { keepCurrent: true });
        }
    });

    panes.trade.addEventListener('keydown', async (event) => {
        const result = event.target.closest('.x-result');
        if (result && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            await loadQuote(result.dataset.symbol);
        }
    });

    // Options tab: load a chain, switch expiry, buy or write a contract
    panes.options.addEventListener('submit', async (event) => {
        event.preventDefault();
        const symbol = document.getElementById('x-chain-symbol').value.trim();
        if (symbol) await loadChain(symbol);
    });

    panes.options.addEventListener('click', async (event) => {
        const expiry = event.target.closest('#x-expiries .segment-btn');
        if (expiry) {
            await loadChain(chainSymbol, expiry.dataset.expiry, { keepCurrent: true });
            return;
        }
        const act = event.target.closest('.x-chain-act');
        if (act) {
            await tradeContract({
                action: act.dataset.action,
                optionType: act.dataset.type,
                strike: Number(act.dataset.strike)
            });
        }
    });

    // Orders tab: place and cancel
    panes.orders.addEventListener('submit', async (event) => {
        event.preventDefault();
        await placeOrder();
    });

    panes.orders.addEventListener('click', async (event) => {
        const cancel = event.target.closest('.x-cancel-order');
        if (!cancel) return;
        if (!await confirmDialog('Cancel this working order?')) return;
        try {
            await api.exchangeCancelOrder(currentGuild, cancel.dataset.id);
            showToast('Order cancelled.');
            await loadOrders({ keepCurrent: true });
        } catch (error) {
            showToast(error.message, true);
        }
    });
}

/**
 * Prepare the exchange pane (idempotent; refreshes the active tab on every
 * visit). The exchange is guild-only, so a user who shares no server with
 * Goobster gets an explanation instead of an empty terminal.
 * @param {Object} params - { me, toast, confirm }
 */
export function initExchange({ me, toast, confirm }) {
    showToast = toast;
    confirmDialog = confirm;

    if (!initialized) {
        initialized = true;
        wire();
    }

    guilds = (me.scopes || []).filter(scope => scope.kind === 'guild');
    if (guilds.length === 0) {
        guildSelect.classList.add('hidden');
        tabs.classList.add('hidden');
        setTab('portfolio');
        panes.portfolio.replaceChildren(el(`<div class="empty">The exchange is per-server:
          wallets, positions, and the feature switches all live in a Discord server.
          Join a server Goobster is in (or invite him to yours) and it shows up here.</div>`));
        return;
    }
    guildSelect.classList.remove('hidden');
    tabs.classList.remove('hidden');

    const previous = currentGuild;
    if (!guilds.some(guild => guild.id === currentGuild)) {
        let remembered = null;
        try { remembered = localStorage.getItem(GUILD_KEY); } catch { /* private mode */ }
        currentGuild = guilds.some(guild => guild.id === remembered) ? remembered : guilds[0].id;
    }
    guildSelect.replaceChildren(...guilds.map(guild => {
        const option = document.createElement('option');
        option.value = guild.id;
        option.textContent = guild.name;
        option.selected = guild.id === currentGuild;
        return option;
    }));
    if (previous !== currentGuild) features = {};

    renderTab();
}
