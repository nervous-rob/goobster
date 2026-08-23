import { useMemo, useState } from 'react';
import { TYPE_COLORS } from '../renderers/graph.js';
import type { FacetCount } from '../lib/graphFilter';

const TYPE_COLOR_MAP = TYPE_COLORS as Record<string, string>;

export type SlicerSelection = {
    types: string[];
    tags: string[];
    sources: string[];
};

function toggleValue(list: string[], value: string): string[] {
    return list.includes(value)
        ? list.filter((item) => item !== value)
        : [...list, value];
}

function Slicer({
    title,
    items,
    selected,
    onChange,
    swatch
}: {
    title: string;
    items: FacetCount[];
    selected: string[];
    onChange: (next: string[]) => void;
    swatch?: (value: string) => string | undefined;
}) {
    const [q, setQ] = useState('');
    const query = q.trim().toLowerCase();
    const visible = useMemo(() => {
        if (!query) return items;
        return items.filter((item) => item.value.toLowerCase().includes(query));
    }, [items, query]);
    const allOn = selected.length === 0;
    return (
        <section className="map-slicer" aria-label={title}>
            <header className="map-slicer-head">
                <div>
                    <div className="map-slicer-title">{title}</div>
                    <div className="map-slicer-meta">
                        {allOn ? 'All' : `${selected.length} selected`}
                    </div>
                </div>
                <button
                    type="button"
                    className="map-slicer-clear"
                    disabled={allOn}
                    onClick={() => onChange([])}
                >
                    Clear
                </button>
            </header>
            <input
                className="input map-slicer-search"
                type="search"
                placeholder={`Search ${title.toLowerCase()}…`}
                value={q}
                onChange={(event) => setQ(event.target.value)}
            />
            <div className="map-slicer-list" role="group" aria-label={title}>
                {visible.length === 0 && (
                    <div className="map-slicer-empty">No matches</div>
                )}
                {visible.map((item) => {
                    const checked = selected.includes(item.value);
                    const color = swatch?.(item.value);
                    return (
                        <label key={item.value} className={`map-slicer-row${checked ? ' on' : ''}`}>
                            <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => onChange(toggleValue(selected, item.value))}
                            />
                            {color ? <span className="dot" style={{ background: color }} /> : null}
                            <span className="map-slicer-name">{item.value}</span>
                            <span className="map-slicer-count">{item.count}</span>
                        </label>
                    );
                })}
            </div>
        </section>
    );
}

export function MapSlicers({
    facets,
    selected,
    onChange
}: {
    facets: { types: FacetCount[]; tags: FacetCount[]; sources: FacetCount[] };
    selected: SlicerSelection;
    onChange: (next: SlicerSelection) => void;
}) {
    return (
        <aside className="map-slicers" aria-label="Map filters">
            <Slicer
                title="Types"
                items={facets.types}
                selected={selected.types}
                onChange={(types) => onChange({ ...selected, types })}
                swatch={(value) => TYPE_COLOR_MAP[value]}
            />
            <Slicer
                title="Tags"
                items={facets.tags}
                selected={selected.tags}
                onChange={(tags) => onChange({ ...selected, tags })}
            />
            {facets.sources.length > 0 && (
                <Slicer
                    title="Sources"
                    items={facets.sources}
                    selected={selected.sources}
                    onChange={(sources) => onChange({ ...selected, sources })}
                />
            )}
        </aside>
    );
}
