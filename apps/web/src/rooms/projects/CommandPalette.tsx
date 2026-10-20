import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { PROJECT_VIEWS, type ProjectViewId } from '../../lib/rooms';
import type { Job } from './types';

/** One thing the palette can jump to (or do). */
type PaletteItem = {
    id: string;
    group: 'Views' | 'Apps' | 'Files' | 'Runs' | 'Plan' | 'Goobster';
    label: string;
    detail?: string;
    run: () => void;
};

type AppRow = { slug: string; name: string; kind: string };
type MissionPayload = { mission: { title: string; steps: { id: number; title: string; status: string }[] } | null };
type SearchPayload = { files: string[] };

/** Every word of the query appears in the text, in any order. */
function matches(text: string, words: string[]) {
    const hay = text.toLowerCase();
    return words.every((word) => hay.includes(word));
}

/**
 * Ctrl/Cmd+K for one project: jump to a view, app, file, run or plan step,
 * or hand the text to Goobster (pre-filled, never sent).
 */
export function CommandPalette({ slug, ownerId, jobs, onClose, onView, onApp, onFile, onRun, askGoobster }: {
    slug: string;
    ownerId?: string | null;
    jobs: Job[];
    onClose: () => void;
    onView: (view: ProjectViewId) => void;
    onApp: (app: string) => void;
    onFile: (path: string) => void;
    onRun: (jobId: number) => void;
    askGoobster: (text: string) => void;
}) {
    const [text, setText] = useState('');
    const [fileQuery, setFileQuery] = useState('');
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const query = text.trim();
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    useEffect(() => { inputRef.current?.focus(); }, []);
    // File names come from the workspace search: wait for a pause in typing.
    useEffect(() => {
        const timer = window.setTimeout(() => setFileQuery(query.length >= 2 ? query : ''), 250);
        return () => window.clearTimeout(timer);
    }, [query]);

    const apps = useQuery({
        queryKey: keys.projectAssets(slug, ownerId),
        queryFn: () => api.projectAssets(slug, 'app', ownerId) as Promise<{ assets: AppRow[] }>,
        retry: false
    });
    const mission = useQuery({
        queryKey: keys.projectMission(slug, ownerId),
        queryFn: () => api.projectMission(slug, ownerId) as Promise<MissionPayload>,
        retry: false
    });
    const files = useQuery({
        queryKey: keys.projectSearch(slug, fileQuery, ownerId),
        queryFn: () => api.projectSearch(slug, fileQuery, null, ownerId) as Promise<SearchPayload>,
        enabled: fileQuery.length >= 2,
        retry: false
    });

    const items = useMemo<PaletteItem[]>(() => {
        const out: PaletteItem[] = [];
        for (const view of PROJECT_VIEWS) {
            if (matches(view.name, words)) out.push({ id: `view:${view.id}`, group: 'Views', label: view.name, run: () => onView(view.id) });
        }
        for (const app of (apps.data?.assets || []).filter((row) => row.kind === 'app')) {
            if (matches(`${app.name} ${app.slug}`, words)) {
                out.push({ id: `app:${app.slug}`, group: 'Apps', label: app.name, detail: app.slug, run: () => onApp(app.slug) });
            }
        }
        if (fileQuery && fileQuery === query) {
            for (const file of (files.data?.files || []).slice(0, 12)) {
                out.push({ id: `file:${file}`, group: 'Files', label: file.split('/').pop() || file, detail: file, run: () => onFile(file) });
            }
        }
        for (const job of jobs.slice(0, 30)) {
            const label = `Run #${job.id}`;
            const detail = [job.status.toLowerCase(), job.language, job.startedBy ? `by ${job.startedBy}` : null].filter(Boolean).join(' · ');
            if (words.length && matches(`${label} ${detail} ${job.id}`, words)) {
                out.push({ id: `run:${job.id}`, group: 'Runs', label, detail, run: () => onRun(job.id) });
            }
        }
        for (const step of mission.data?.mission?.steps || []) {
            if (words.length && matches(step.title, words)) {
                out.push({ id: `step:${step.id}`, group: 'Plan', label: step.title, detail: step.status.toLowerCase(), run: () => onView('plan') });
            }
        }
        if (query) {
            out.push({ id: 'ask', group: 'Goobster', label: `Ask Goobster: “${query}”`, detail: 'opens the chat with this filled in', run: () => askGoobster(query) });
        }
        return out;
    }, [words.join(' '), query, fileQuery, apps.data, files.data, mission.data, jobs, onView, onApp, onFile, onRun, askGoobster]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => { setActive(0); }, [query]);
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    function choose(item: PaletteItem | undefined) {
        if (!item) return;
        onClose();
        item.run();
    }

    let lastGroup: string | null = null;
    return (
        <div className="cmdk-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
            <div className="cmdk" role="dialog" aria-modal="true" aria-label="Go to anything in this project">
                <input
                    ref={inputRef}
                    className="cmdk-input"
                    role="combobox"
                    aria-expanded="true"
                    aria-controls="cmdk-list"
                    aria-activedescendant={items[active] ? `cmdk-${active}` : undefined}
                    placeholder="Go to a view, app, file, run or plan step… or ask Goobster"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
                        else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((n) => Math.min(items.length - 1, n + 1)); }
                        else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((n) => Math.max(0, n - 1)); }
                        else if (event.key === 'Enter') { event.preventDefault(); choose(items[active]); }
                    }}
                />
                <ul className="cmdk-list" id="cmdk-list" role="listbox" ref={listRef}>
                    {items.map((item, index) => {
                        const heading = item.group !== lastGroup ? item.group : null;
                        lastGroup = item.group;
                        return (
                            <li key={item.id} role="presentation">
                                {heading && <div className="cmdk-group" role="presentation">{heading}</div>}
                                <div
                                    id={`cmdk-${index}`}
                                    data-index={index}
                                    role="option"
                                    aria-selected={index === active}
                                    className={`cmdk-item${index === active ? ' active' : ''}`}
                                    onMouseMove={() => setActive(index)}
                                    onClick={() => choose(item)}
                                >
                                    <span className="cmdk-label">{item.label}</span>
                                    {item.detail && <span className="cmdk-detail">{item.detail}</span>}
                                </div>
                            </li>
                        );
                    })}
                    {fileQuery && files.isFetching && <li className="cmdk-note" role="presentation">Searching files…</li>}
                    {!items.length && <li className="cmdk-note" role="presentation">Type to search this project.</li>}
                </ul>
                <div className="cmdk-foot hint">↑ ↓ to move · Enter to open · Esc to close</div>
            </div>
        </div>
    );
}
