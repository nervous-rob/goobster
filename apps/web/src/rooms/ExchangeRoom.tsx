import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useMe } from '../hooks/useSession';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';

type ExchangeTab = 'portfolio' | 'trade' | 'options' | 'orders' | 'leaderboard';
const GUILD_KEY = 'goobster-exchange-guild';
const HISTORY_RANGES = ['1mo', '3mo', '6mo', '1y'] as const;

type Features = { options?: boolean; optionsEnabled?: boolean; marginEnabled?: boolean };
type Snapshot = {
    equity?: number;
    cash?: number;
    buyingPower?: number;
    exposure?: number;
    leverageUsed?: number;
    debt?: number;
    maintenance?: number;
    excessLiquidity?: number;
    marginCall?: boolean;
    pricingGaps?: number;
    account?: { accountType?: string; leverage?: number; goblinMode?: boolean; marginLoan?: number; accruedInterest?: number };
    longs?: Position[];
    shorts?: Position[];
    options?: OptionPosition[];
    perps?: PerpPosition[];
    liquidationLevels?: Array<{ symbol: string; direction: string; price: number }>;
};
type Position = {
    symbol: string; units: number; costBasis?: number; proceeds?: number; price?: number;
    value?: number; profitLoss?: number; stale?: boolean; borrowFeeAccrued?: number;
};
type OptionPosition = {
    underlying: string; strike: number; optionType: string; expiry: string; side: string;
    contracts: number; costBasis?: number; mark?: number; value?: number; profitLoss?: number;
    zeroDte?: boolean; daysToExpiry?: number | null; greeks?: { delta: number };
};
type PerpPosition = {
    symbol: string; direction: string; leverage: number; units: number; entryPrice?: number;
    margin?: number; liquidationPrice?: number; fundingAccrued?: number; value?: number; unrealized?: number;
};
type Overview = {
    features?: Features;
    currencyName?: string;
    audit?: {
        snapshot: Snapshot;
        risks?: string[];
        realized?: Record<string, number>;
        ledger?: { reconciles?: boolean; recent?: Array<{ type: string; createdAt?: string; amount?: number; balanceAfter?: number }> };
        events?: Array<{ eventType: string; symbol?: string; createdAt?: string; amount?: number | null }>;
        asOf?: string;
    };
};
type QuoteView = {
    quote: { symbol: string; name?: string; price: number; stale?: boolean; asOf?: string };
    holding?: Position | null;
    shortPosition?: Position | null;
    balance?: number;
    currencyName?: string;
};
type HistoryPayload = { points?: Array<{ date: string; close: number }> };
type SearchMatch = { symbol: string; name?: string; exchange?: string };
type ChainRow = {
    strike: number;
    call: ChainContract;
    put: ChainContract;
};
type ChainContract = {
    strike: number; bid?: number; mid?: number; ask?: number; costPerContract?: number;
    creditPerContract?: number; iv?: number; probabilityItm?: number; greeks: { delta: number };
};
type Chain = {
    label: string; name?: string; spot: number; stale?: boolean; zeroDte?: boolean;
    underlying?: string; underlyingAlias?: string; expiry: string;
    expiries: Array<{ expiry: string; label: string }>;
    rows: ChainRow[];
};
type Order = {
    id: number; symbol: string; side: string; orderType: string; status: string;
    units: number; limitPrice?: number | null; stopPrice?: number | null;
    trailPercent?: number | null; filledPrice?: number | null; note?: string;
};
type Leaderboard = { rows: Array<{ name?: string; userId?: string; isBot?: boolean; accountType?: string; marginCall?: boolean; cash?: number; exposure?: number; debt?: number; equity?: number }>; currencyName?: string };

function isBotOffline(error: unknown): boolean {
    return error instanceof ApiError && (error.status === 503 || error.code === 'BOT_OFFLINE');
}

function errorText(error: unknown): string {
    if (isBotOffline(error)) {
        return 'Goobster is offline right now — the Exchange needs the Discord bot connected. Try again once it is back.';
    }
    return (error as Error).message || 'Request failed';
}

function points(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return Math.round(value).toLocaleString();
}

function usd(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function units(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function whenLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Pl({ value }: { value: number | null | undefined }) {
    if (value === null || value === undefined) return <span className="x-pl">—</span>;
    const rounded = Math.round(value);
    const cls = rounded > 0 ? 'up' : rounded < 0 ? 'down' : '';
    return <span className={`x-pl ${cls}`}>{rounded > 0 ? '+' : ''}{rounded.toLocaleString()}</span>;
}

function Stat({ label, value, sub }: { label: string; value: string | number | ReactNode; sub?: string }) {
    return (
        <div className="stat-card">
            <div className="stat-label">{label}</div>
            <div className="stat-value">{value}</div>
            {sub ? <div className="stat-sub">{sub}</div> : null}
        </div>
    );
}

function optionsEnabled(features?: Features): boolean {
    return Boolean(features?.options || features?.optionsEnabled);
}

function drawHistory(canvas: HTMLCanvasElement, series: Array<{ date: string; close: number }>): void {
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
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const pad = { left: 52, right: 8, top: 10, bottom: 20 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const closes = series.map((p) => p.close);
    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const x = (i: number) => pad.left + (plotW * i) / Math.max(1, series.length - 1);
    const y = (value: number) => pad.top + plotH - (plotH * (value - min)) / span;
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

function optionLabel(position: OptionPosition): string {
    const type = position.optionType === 'CALL' ? 'C' : 'P';
    return `${position.underlying} ${position.strike}${type} ${position.expiry}`;
}

function Portfolio({ overview }: { overview: Overview }) {
    const snap = overview.audit?.snapshot || {};
    const audit = overview.audit;
    const currency = overview.currencyName || 'points';
    const longs = snap.longs || [];
    const shorts = snap.shorts || [];
    const opts = snap.options || [];
    const perps = snap.perps || [];
    const empty = longs.length === 0 && shorts.length === 0 && opts.length === 0 && perps.length === 0;
    const realized = audit?.realized || {};
    return (
        <>
            <div className="stat-grid">
                <Stat label="Equity" value={points(snap.equity)} sub="cash + positions − debt" />
                <Stat label="Cash" value={points(snap.cash)} sub={currency} />
                <Stat label="Buying power" value={points(snap.buyingPower)} sub={`${snap.account?.accountType || ''} account`} />
                <Stat label="Exposure" value={points(snap.exposure)} sub={snap.leverageUsed ? `${snap.leverageUsed.toFixed(2)}× equity` : 'no positions'} />
            </div>
            {(Number(snap.debt) > 0 || snap.account?.accountType === 'MARGIN') && (
                <div className="stat-grid">
                    <Stat label="Debt" value={points(snap.debt)} sub={`loan ${points(snap.account?.marginLoan)} + interest ${points(snap.account?.accruedInterest)}`} />
                    <Stat label="Maintenance" value={points(snap.maintenance)} sub="required equity" />
                    <Stat label="Excess liquidity" value={points(snap.excessLiquidity)} sub={snap.marginCall ? 'MARGIN CALL' : 'above requirement'} />
                    <Stat label="Leverage tier" value={`${snap.account?.leverage || 1}×`} sub={snap.account?.goblinMode ? 'Goblin Mode on' : 'Goblin Mode off'} />
                </div>
            )}
            {snap.marginCall && (
                <div className="x-alert danger">⚠ Margin call — equity ({points(snap.equity)}) is below the maintenance requirement ({points(snap.maintenance)}).</div>
            )}
            {Number(snap.pricingGaps) > 0 && (
                <div className="x-alert">{snap.pricingGaps} position(s) could not be priced right now.</div>
            )}
            {(audit?.risks || []).map((risk) => <div key={risk} className="x-alert">{risk}</div>)}
            {longs.length > 0 && (
                <div className="x-block">
                    <div className="section-title">Stocks</div>
                    <div className="list-card x-table">
                        {longs.map((position) => (
                            <div key={position.symbol} className="list-row">
                                <div className="row-body">
                                    <code>{position.symbol}</code>
                                    <div className="row-meta">{units(position.units)} units · cost {points(position.costBasis)} · {usd(position.price)}{position.stale ? ' (stale)' : ''}</div>
                                </div>
                                <div className="x-numbers"><span>{points(position.value)}</span><Pl value={position.profitLoss} /></div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {shorts.length > 0 && (
                <div className="x-block">
                    <div className="section-title">Shorts</div>
                    <div className="list-card x-table">
                        {shorts.map((position) => (
                            <div key={`s-${position.symbol}`} className="list-row">
                                <div className="row-body">
                                    <code>{position.symbol}</code>
                                    <span className="badge">SHORT</span>
                                    <div className="row-meta">{units(position.units)} units owed · credit {points(position.proceeds)}</div>
                                </div>
                                <div className="x-numbers"><span>{points(position.value)} to cover</span><Pl value={position.profitLoss} /></div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {opts.length > 0 && (
                <div className="x-block">
                    <div className="section-title">Options</div>
                    <div className="list-card x-table">
                        {opts.map((position) => (
                            <div key={optionLabel(position)} className="list-row">
                                <div className="row-body">
                                    <code>{optionLabel(position)}</code>
                                    <span className={`badge${position.side === 'SHORT' ? ' warn' : ''}`}>{position.side}</span>
                                    <div className="row-meta">{position.contracts} contract(s) · mark {usd(position.mark)}</div>
                                </div>
                                <div className="x-numbers"><span>{points(position.value)}</span><Pl value={position.profitLoss} /></div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {perps.length > 0 && (
                <div className="x-block">
                    <div className="section-title">Perpetual futures</div>
                    <div className="list-card x-table">
                        {perps.map((position) => (
                            <div key={`p-${position.symbol}`} className="list-row">
                                <div className="row-body">
                                    <code>{position.symbol}</code>
                                    <span className="badge">{position.direction} {position.leverage}×</span>
                                    <div className="row-meta">{units(position.units)} units · entry {usd(position.entryPrice)}</div>
                                </div>
                                <div className="x-numbers"><span>{points(position.value)}</span><Pl value={position.unrealized} /></div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {empty && <div className="empty">No open positions — head to <strong>Trade</strong> to buy your first {currency} worth of stock.</div>}
            <div className="x-block">
                <div className="section-title">Realized</div>
                <div className="stat-grid">
                    <Stat label="Options" value={<Pl value={realized.options} />} sub={`${realized.optionsClosed || 0} closed`} />
                    <Stat label="Shorts" value={<Pl value={realized.shorts} />} sub={`${realized.shortCovers || 0} covers`} />
                    <Stat label="Futures" value={<Pl value={realized.perps} />} />
                    <Stat label="Dividends" value={<Pl value={realized.dividendsNet} />} />
                </div>
            </div>
            {audit?.ledger?.recent && audit.ledger.recent.length > 0 && (
                <div className="x-block">
                    <div className="section-title">Wallet ledger</div>
                    <div className="hint">{audit.ledger.reconciles ? '✓ Every point in this wallet is explained by the ledger.' : '⚠ The ledger and the wallet disagree.'}</div>
                    <div className="list-card x-table">
                        {audit.ledger.recent.map((entry, index) => (
                            <div key={`${entry.type}-${entry.createdAt}-${index}`} className="list-row">
                                <div className="row-body">
                                    {entry.type}
                                    <div className="row-meta">{whenLabel(entry.createdAt)}</div>
                                </div>
                                <div className="x-numbers"><Pl value={entry.amount} /><span>→ {points(entry.balanceAfter)}</span></div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </>
    );
}

function TradeTab({ guildId, currencyName, features }: { guildId: string; currencyName: string; features?: Features }) {
    const toast = useToast();
    const confirm = useConfirm();
    const [query, setQuery] = useState('');
    const [symbol, setSymbol] = useState('');
    const [range, setRange] = useState<typeof HISTORY_RANGES[number]>('3mo');
    const [matches, setMatches] = useState<SearchMatch[]>([]);
    const [unitsInput, setUnitsInput] = useState('');
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const quote = useQuery({
        queryKey: ['exchange-quote', guildId, symbol],
        queryFn: () => api.exchangeQuote(guildId, symbol) as Promise<QuoteView>,
        enabled: Boolean(symbol)
    });
    const history = useQuery({
        queryKey: ['exchange-history', guildId, symbol, range],
        queryFn: () => api.exchangeHistory(guildId, symbol, range) as Promise<HistoryPayload>,
        enabled: Boolean(symbol)
    });

    useEffect(() => {
        const canvas = canvasRef.current;
        const points = history.data?.points;
        if (!canvas || !points || points.length < 2) return;
        const paint = () => drawHistory(canvas, points);
        const frame = requestAnimationFrame(paint);
        const observer = new ResizeObserver(() => paint());
        observer.observe(canvas);
        return () => { cancelAnimationFrame(frame); observer.disconnect(); };
    }, [history.data]);

    async function search() {
        const q = query.trim();
        if (!q) return;
        try {
            const result = await api.exchangeSearch(guildId, q) as { results: SearchMatch[] };
            setMatches(result.results || []);
            if ((result.results || []).length === 0) toast('No matches.', true);
        } catch (error) {
            toast(errorText(error), true);
        }
    }

    async function trade(side: string) {
        const raw = unitsInput.trim();
        if (!raw && (side === 'buy' || side === 'short')) {
            toast('Enter how many units to trade.', true);
            return;
        }
        if (side === 'short' && !await confirm(`Short ${raw} units of ${symbol}? Losses are unbounded until you cover.`)) return;
        try {
            const result = await api.exchangeTrade(guildId, {
                side, symbol, units: raw === '' ? null : Number(raw)
            }) as { units: number; symbol: string; price: number; cost?: number; proceeds?: number; balance: number };
            const moved = result.cost ?? result.proceeds ?? 0;
            toast(`${side} ${units(result.units)} ${result.symbol} @ ${usd(result.price)} (${Math.round(moved).toLocaleString()} ${currencyName})`);
            setUnitsInput('');
            await quote.refetch();
        } catch (error) {
            toast(errorText(error), true);
        }
    }

    const view = quote.data;
    const canShort = Boolean(features?.marginEnabled);

    return (
        <>
            <form className="x-search-row" onSubmit={(event: FormEvent) => { event.preventDefault(); const s = query.trim(); if (s) { setSymbol(s.toUpperCase()); setMatches([]); } }}>
                <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Symbol or company (AAPL, tesla…)" aria-label="Symbol or company name" />
                <button className="btn primary" type="submit">Quote</button>
                <button className="btn" type="button" onClick={() => void search()}>Search</button>
            </form>
            {matches.length > 0 && (
                <div className="list-card x-table">
                    {matches.map((match) => (
                        <button
                            key={match.symbol}
                            type="button"
                            className="list-row x-result"
                            onClick={() => { setSymbol(match.symbol); setQuery(match.symbol); setMatches([]); }}
                        >
                            <div className="row-body">
                                <code>{match.symbol}</code>
                                <div className="row-meta">{match.name || ''}{match.exchange ? ` · ${match.exchange}` : ''}</div>
                            </div>
                        </button>
                    ))}
                </div>
            )}
            {quote.isError && <div className="empty">{errorText(quote.error)}</div>}
            {!view && !quote.isPending && !symbol && (
                <div className="empty">Look up a symbol to trade it. Buying debits points at 1 point = $1.</div>
            )}
            {view && (
                <>
                    <div className="x-block">
                        <div className="x-quote-head">
                            <div>
                                <div className="x-quote-symbol">
                                    <code>{view.quote.symbol}</code>
                                    {view.quote.stale ? <span className="badge warn">stale</span> : null}
                                </div>
                                <div className="hint">{view.quote.name || ''}</div>
                            </div>
                            <div className="x-quote-price">{usd(view.quote.price)}</div>
                        </div>
                        <div className="hint">Priced {whenLabel(view.quote.asOf)} · wallet {points(view.balance)} {currencyName}</div>
                    </div>
                    <div className="x-block">
                        <div className="x-chart-head">
                            <div className="section-title" style={{ margin: 0 }}>Price history</div>
                            <div className="segment" role="group" aria-label="History range">
                                {HISTORY_RANGES.map((item) => (
                                    <button key={item} type="button" className={`segment-btn${range === item ? ' active' : ''}`} onClick={() => setRange(item)}>{item}</button>
                                ))}
                            </div>
                        </div>
                        <div className="list-card x-chart-card">
                            {(history.data?.points?.length || 0) > 1
                                ? <canvas ref={canvasRef} className="x-chart" role="img" aria-label="Daily closing price chart" />
                                : <div className="empty">No history available for this symbol.</div>}
                        </div>
                    </div>
                    <div className="x-block">
                        <div className="section-title">Market order</div>
                        <form className="x-form" onSubmit={(event) => event.preventDefault()}>
                            <div className="field">
                                <label htmlFor="x-trade-units">Units</label>
                                <input id="x-trade-units" className="input" type="number" min={0} step="0.0001" value={unitsInput} onChange={(e) => setUnitsInput(e.target.value)} placeholder="units" />
                            </div>
                            <div className="x-btn-row">
                                <button className="btn primary" type="button" onClick={() => void trade('buy')}>Buy</button>
                                <button className="btn" type="button" onClick={() => void trade('sell')}>Sell</button>
                                <button className="btn" type="button" disabled={!canShort} onClick={() => void trade('short')}>Short</button>
                                <button className="btn" type="button" disabled={!canShort} onClick={() => void trade('cover')}>Cover</button>
                            </div>
                            <div className="hint">Buys round the point cost up and sells round it down — rounding always favours the house.</div>
                        </form>
                    </div>
                </>
            )}
        </>
    );
}

function OptionsTab({ guildId, currencyName }: { guildId: string; currencyName: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const [symbol, setSymbol] = useState('');
    const [lookup, setLookup] = useState('');
    const [expiry, setExpiry] = useState<string | null>(null);
    const [contracts, setContracts] = useState(1);
    const chain = useQuery({
        queryKey: ['exchange-chain', guildId, symbol, expiry],
        queryFn: () => api.exchangeChain(guildId, symbol, expiry) as Promise<Chain>,
        enabled: Boolean(symbol)
    });
    const data = chain.data;

    async function trade(action: string, optionType: string, strike: number) {
        if (!Number.isFinite(contracts) || contracts <= 0) {
            toast('Contracts must be a positive number.', true);
            return;
        }
        if (action === 'write' && !await confirm(`Write ${contracts} ${symbol} ${strike} ${optionType}? Writing collects premium now but a written call has unbounded loss.`)) return;
        try {
            const result = await api.exchangeTradeOption(guildId, {
                action, symbol, optionType, strike, expiry: data?.expiry || expiry, contracts
            }) as { contracts: number; cost?: number; credit?: number; balance: number };
            const moved = result.cost ?? result.credit ?? 0;
            toast(`${action} ${result.contracts} contract(s) for ${Math.round(moved).toLocaleString()} ${currencyName}`);
            await chain.refetch();
        } catch (error) {
            toast(errorText(error), true);
        }
    }

    return (
        <>
            <form className="x-search-row" onSubmit={(event) => { event.preventDefault(); if (lookup.trim()) { setSymbol(lookup.trim().toUpperCase()); setExpiry(null); } }}>
                <input className="input" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Underlying (AAPL, SPX…)" aria-label="Option underlying" />
                <button className="btn primary" type="submit">Load chain</button>
            </form>
            {chain.isError && <div className="empty">{errorText(chain.error)}</div>}
            {!data && !chain.isPending && <div className="empty">Load an underlying to see its chain. Premiums are simulated.</div>}
            {data && (
                <>
                    <div className="x-block">
                        <div className="x-quote-head">
                            <div>
                                <div className="x-quote-symbol">
                                    <code>{data.label}</code>
                                    {data.stale ? <span className="badge warn">stale</span> : null}
                                    {data.zeroDte ? <span className="badge danger">0DTE</span> : null}
                                </div>
                                <div className="hint">{data.name || ''}</div>
                            </div>
                            <div className="x-quote-price">{usd(data.spot)}</div>
                        </div>
                        <div className="segment x-expiries" role="group" aria-label="Expiry">
                            {data.expiries.map((item) => (
                                <button key={item.expiry} type="button" className={`segment-btn${item.expiry === data.expiry ? ' active' : ''}`} onClick={() => setExpiry(item.expiry)}>
                                    {item.expiry} <span className="row-meta">{item.label}</span>
                                </button>
                            ))}
                        </div>
                        <div className="x-contracts-row">
                            <label htmlFor="x-contracts">Contracts per trade</label>
                            <input id="x-contracts" className="input" type="number" min={1} step={1} value={contracts} onChange={(e) => setContracts(Number(e.target.value))} />
                        </div>
                    </div>
                    <div className="x-block">
                        <div className="x-chain-head"><div>Calls</div><div>Strike</div><div>Puts</div></div>
                        <div className="list-card x-chain">
                            {data.rows.map((row) => (
                                <div key={row.strike} className="x-chain-row">
                                    <div className="x-chain-side">
                                        <div className="x-chain-prices">
                                            <span title="bid">{usd(row.call.bid)}</span>
                                            <span className="x-chain-mid" title="mid">{usd(row.call.mid)}</span>
                                            <span title="ask">{usd(row.call.ask)}</span>
                                        </div>
                                        <div className="x-btn-row">
                                            <button type="button" className="btn small" onClick={() => void trade('buy', 'CALL', row.strike)}>Buy {points(row.call.costPerContract)}</button>
                                            <button type="button" className="btn small subtle" onClick={() => void trade('write', 'CALL', row.strike)}>Write +{points(row.call.creditPerContract)}</button>
                                        </div>
                                    </div>
                                    <div className="x-chain-strike">{row.strike}</div>
                                    <div className="x-chain-side">
                                        <div className="x-chain-prices">
                                            <span title="bid">{usd(row.put.bid)}</span>
                                            <span className="x-chain-mid" title="mid">{usd(row.put.mid)}</span>
                                            <span title="ask">{usd(row.put.ask)}</span>
                                        </div>
                                        <div className="x-btn-row">
                                            <button type="button" className="btn small" onClick={() => void trade('buy', 'PUT', row.strike)}>Buy {points(row.put.costPerContract)}</button>
                                            <button type="button" className="btn small subtle" onClick={() => void trade('write', 'PUT', row.strike)}>Write +{points(row.put.creditPerContract)}</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </>
    );
}

function OrdersTab({ guildId }: { guildId: string }) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const orders = useQuery({
        queryKey: ['exchange-orders', guildId],
        queryFn: () => api.exchangeOrders(guildId) as Promise<{ orders: Order[] }>
    });
    const [form, setForm] = useState({
        symbol: '', side: 'BUY', orderType: 'LIMIT', units: '', limitPrice: '', stopPrice: '', trailPercent: ''
    });

    function field(id: keyof typeof form) {
        return (event: { target: { value: string } }) => setForm((prev) => ({ ...prev, [id]: event.target.value }));
    }

    async function place(event: FormEvent) {
        event.preventDefault();
        const number = (raw: string) => (raw.trim() === '' ? null : Number(raw));
        try {
            const result = await api.exchangePlaceOrder(guildId, {
                symbol: form.symbol,
                side: form.side,
                orderType: form.orderType,
                units: number(form.units),
                limitPrice: number(form.limitPrice),
                stopPrice: number(form.stopPrice),
                trailPercent: number(form.trailPercent)
            }) as { order: { id: number }; triggerHint?: string };
            toast(`Order #${result.order.id} working — ${result.triggerHint || 'queued'}`);
            await queryClient.invalidateQueries({ queryKey: ['exchange-orders', guildId] });
        } catch (error) {
            toast(errorText(error), true);
        }
    }

    return (
        <>
            <div className="x-block">
                <div className="section-title">Place a resting order</div>
                <form className="x-form" onSubmit={(event) => void place(event)}>
                    <div className="x-form-grid">
                        <div className="field"><label>Symbol</label><input className="input" value={form.symbol} onChange={field('symbol')} placeholder="AAPL" /></div>
                        <div className="field">
                            <label>Side</label>
                            <select className="select" value={form.side} onChange={field('side')}>
                                <option value="BUY">Buy</option>
                                <option value="SELL">Sell</option>
                                <option value="SHORT">Short</option>
                                <option value="COVER">Cover</option>
                            </select>
                        </div>
                        <div className="field">
                            <label>Type</label>
                            <select className="select" value={form.orderType} onChange={field('orderType')}>
                                <option value="LIMIT">Limit</option>
                                <option value="STOP">Stop</option>
                                <option value="STOP_LIMIT">Stop limit</option>
                                <option value="TRAILING_STOP">Trailing stop</option>
                            </select>
                        </div>
                        <div className="field"><label>Units</label><input className="input" type="number" value={form.units} onChange={field('units')} placeholder="1" /></div>
                        <div className="field"><label>Limit price</label><input className="input" type="number" value={form.limitPrice} onChange={field('limitPrice')} placeholder="optional" /></div>
                        <div className="field"><label>Stop price</label><input className="input" type="number" value={form.stopPrice} onChange={field('stopPrice')} placeholder="optional" /></div>
                        <div className="field"><label>Trail %</label><input className="input" type="number" value={form.trailPercent} onChange={field('trailPercent')} placeholder="optional" /></div>
                    </div>
                    <div className="x-btn-row"><button className="btn primary" type="submit">Place order</button></div>
                    <div className="hint">The risk engine evaluates resting orders every 5 minutes against the live quote.</div>
                </form>
            </div>
            {orders.isPending && <div className="empty">Loading…</div>}
            {orders.isError && <div className="empty">{errorText(orders.error)}</div>}
            {orders.data && orders.data.orders.length === 0 && <div className="empty">No orders yet.</div>}
            {orders.data && orders.data.orders.length > 0 && (
                <div className="x-block">
                    <div className="section-title">Orders</div>
                    <div className="list-card x-table">
                        {orders.data.orders.map((order) => {
                            const working = order.status === 'OPEN' || order.status === 'TRIGGERED';
                            return (
                                <div key={order.id} className="list-row">
                                    <div className="row-body">
                                        <code>{order.symbol}</code>
                                        <span className="badge">{order.side} {order.orderType}</span>
                                        <span className={`badge${working ? '' : ' warn'}`}>{order.status}</span>
                                        <div className="row-meta">
                                            {units(order.units)} units
                                            {order.limitPrice ? ` · limit ${usd(order.limitPrice)}` : ''}
                                            {order.stopPrice ? ` · stop ${usd(order.stopPrice)}` : ''}
                                            {order.note ? ` · ${order.note}` : ''}
                                        </div>
                                    </div>
                                    <div className="x-numbers">
                                        {working && (
                                            <button
                                                type="button"
                                                className="btn small danger"
                                                onClick={async () => {
                                                    if (!await confirm('Cancel this working order?')) return;
                                                    try {
                                                        await api.exchangeCancelOrder(guildId, order.id);
                                                        toast('Order cancelled.');
                                                        queryClient.invalidateQueries({ queryKey: ['exchange-orders', guildId] });
                                                    } catch (error) {
                                                        toast(errorText(error), true);
                                                    }
                                                }}
                                            >Cancel</button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </>
    );
}

export function ExchangeRoom() {
    const me = useMe();
    const toast = useToast();
    const guilds = (me.scopes || []).filter((scope) => scope.kind === 'guild');
    const [guildId, setGuildId] = useState(() => {
        try {
            const remembered = localStorage.getItem(GUILD_KEY);
            if (remembered && guilds.some((g) => g.id === remembered)) return remembered;
        } catch { /* private mode */ }
        return guilds[0]?.id || '';
    });
    const [tab, setTab] = useState<ExchangeTab>('portfolio');

    const overview = useQuery({
        queryKey: ['exchange-overview', guildId],
        queryFn: () => api.exchangeOverview(guildId) as Promise<Overview>,
        enabled: Boolean(guildId)
    });
    const leaderboard = useQuery({
        queryKey: ['exchange-leaderboard', guildId],
        queryFn: () => api.exchangeLeaderboard(guildId) as Promise<Leaderboard>,
        enabled: Boolean(guildId) && tab === 'leaderboard'
    });

    useEffect(() => {
        if (overview.error) toast(errorText(overview.error), true);
    }, [overview.error, toast]);

    const features = overview.data?.features;
    const showOptions = optionsEnabled(features);
    const currency = overview.data?.currencyName || 'points';

    useEffect(() => {
        if (tab === 'options' && overview.data && !showOptions) setTab('portfolio');
    }, [tab, showOptions, overview.data]);

    function pickGuild(id: string) {
        setGuildId(id);
        try { localStorage.setItem(GUILD_KEY, id); } catch { /* private mode */ }
        setTab('portfolio');
    }

    if (guilds.length === 0) {
        return (
            <main className="pane next-pane is-in" id="pane-exchange">
                <header className="pane-header"><h1>Exchange</h1></header>
                <div className="pane-body">
                    <div className="empty">
                        The exchange is per-server: wallets, positions, and the feature switches all live in a Discord server.
                        Join a server Goobster is in (or invite him to yours) and it shows up here.
                    </div>
                </div>
            </main>
        );
    }

    const offline = overview.isError && isBotOffline(overview.error);

    return (
        <main className="pane next-pane is-in" id="pane-exchange">
            <header className="pane-header">
                <h1>Exchange</h1>
                <select className="select" value={guildId} onChange={(e) => pickGuild(e.target.value)} aria-label="Server">
                    {guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}
                </select>
            </header>
            <div className="pane-body">
                {offline && (
                    <div className="empty">{errorText(overview.error)}</div>
                )}
                {!offline && (
                    <>
                        <div className="segment" role="tablist">
                            {([
                                ['portfolio', 'Portfolio'],
                                ['trade', 'Trade'],
                                ...(showOptions ? [['options', 'Options'] as const] : []),
                                ['orders', 'Orders'],
                                ['leaderboard', 'Leaderboard']
                            ] as Array<[ExchangeTab, string]>).map(([id, label]) => (
                                <button key={id} type="button" className={`segment-btn${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>{label}</button>
                            ))}
                        </div>
                        {tab === 'portfolio' && overview.isPending && <div className="empty">Loading…</div>}
                        {tab === 'portfolio' && overview.isError && <div className="empty">{errorText(overview.error)}</div>}
                        {tab === 'portfolio' && overview.data && <Portfolio overview={overview.data} />}
                        {tab === 'trade' && <TradeTab guildId={guildId} currencyName={currency} features={features} />}
                        {tab === 'options' && showOptions && <OptionsTab guildId={guildId} currencyName={currency} />}
                        {tab === 'orders' && <OrdersTab guildId={guildId} />}
                        {tab === 'leaderboard' && (
                            <>
                                {leaderboard.isPending && <div className="empty">Loading…</div>}
                                {leaderboard.isError && <div className="empty">{errorText(leaderboard.error)}</div>}
                                {leaderboard.data && leaderboard.data.rows.length === 0 && <div className="empty">Nobody is trading here yet.</div>}
                                {leaderboard.data && leaderboard.data.rows.length > 0 && (
                                    <>
                                        <div className="list-card x-table">
                                            {leaderboard.data.rows.map((row, index) => (
                                                <div key={row.userId || row.name || index} className="list-row">
                                                    <div className="row-body">
                                                        <span className="x-rank">#{index + 1}</span>
                                                        {row.name || row.userId}
                                                        {row.isBot ? <span className="badge">bot</span> : null}
                                                        <span className="badge">{row.accountType}</span>
                                                        {row.marginCall ? <span className="badge danger">margin call</span> : null}
                                                        <div className="row-meta">cash {points(row.cash)} · exposure {points(row.exposure)} · debt {points(row.debt)}</div>
                                                    </div>
                                                    <div className="x-numbers"><span className="x-equity">{points(row.equity)}</span></div>
                                                </div>
                                            ))}
                                        </div>
                                        <div className="hint" style={{ marginTop: 10 }}>
                                            Ranked by <strong>equity</strong> ({leaderboard.data.currencyName || currency}).
                                        </div>
                                    </>
                                )}
                            </>
                        )}
                    </>
                )}
            </div>
        </main>
    );
}
