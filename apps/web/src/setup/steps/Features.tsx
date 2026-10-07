import { useMemo, useState } from 'react';
import { useAnswers } from '../answers';
import { useSource } from '../data';
import { CORE, dependentsOf, everyFeature, missingDependencies, recommendedFeatures, selectedFeatures, titleOf } from '../model';
import { describeError, ErrorSummary, formatBytes, StepFrame, StepNav, type Problem } from '../ui';
import type { StepProps } from './order';

/** Which parts of Goobster to install. A part left out is not copied at all; it can be added later. */
export function Features({ go }: StepProps) {
    const { answers, update } = useAnswers();
    const source = useSource(answers.sourceDir);
    const [problems, setProblems] = useState<Problem[]>([]);
    const data = source.data;
    const selected = useMemo(() => new Set(selectedFeatures(answers, data)), [answers, data]);

    function set(next: string[]) { update((previous) => ({ ...previous, features: next })); }
    function toggle(id: string, on: boolean) {
        if (!data) return;
        const next = new Set(selected);
        if (on) next.add(id);
        else { next.delete(id); }
        set([...next]);
    }
    const total = data ? data.features.filter((feature) => feature.id === CORE || selected.has(feature.id)).reduce((sum, feature) => sum + feature.bytes, 0) : 0;

    function next() {
        if (!data) return;
        const found: Problem[] = [];
        for (const id of selected) {
            const missing = missingDependencies(data, selected, id);
            if (missing.length > 0) {
                found.push({ field: `feature-${id}`, message: `${titleOf(data, id)} needs ${missing.map((dep) => titleOf(data, dep)).join(' and ')}. Turn ${missing.length === 1 ? 'it' : 'them'} on, or turn ${titleOf(data, id)} off.` });
            }
        }
        setProblems(found);
        if (found.length === 0) go('connections');
    }

    return (
        <StepFrame id="features" title="What should Goobster be able to do?"
            lead="Core is always installed. Everything else is a part you can leave out; a part you skip is not copied at all, and you can add it later.">
            <ErrorSummary problems={problems} />
            {source.isPending && source.fetchStatus !== 'idle' && <p role="status" className="hint">Reading the release…</p>}
            {source.isError && <p role="alert" className="settings-danger">{describeError(source.error).message} <a href="#/setup/where">Choose the release again</a>.</p>}
            {!answers.sourceDir.trim() && <p role="alert" className="settings-danger">Choose a release first. <a href="#/setup/where">Go to Where</a>.</p>}
            {data && (
                <>
                    <div className="wizard-presets" role="group" aria-label="Presets">
                        <button type="button" className="btn small" onClick={() => set(recommendedFeatures(data))} data-testid="preset-recommended">Recommended</button>
                        <button type="button" className="btn small" onClick={() => set(everyFeature(data))} data-testid="preset-everything">Everything</button>
                        <button type="button" className="btn small" onClick={() => set([])} data-testid="preset-minimal">Only the core</button>
                    </div>
                    <ul className="list-card wizard-features" style={{ listStyle: 'none', padding: 0 }}>
                        {data.features.map((feature) => {
                            const isCore = feature.id === CORE;
                            const on = isCore || selected.has(feature.id);
                            const missing = on && !isCore ? missingDependencies(data, selected, feature.id) : [];
                            const dependents = !on ? [] : dependentsOf(data, feature.id).filter((id) => selected.has(id));
                            return (
                                <li key={feature.id} className="list-row" data-testid="feature-row" data-feature={feature.id}
                                    style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                                    <label htmlFor={`feature-${feature.id}`} className="wizard-choice">
                                        <input id={`feature-${feature.id}`} type="checkbox" checked={on} disabled={isCore}
                                            onChange={(event) => toggle(feature.id, event.target.checked)} data-testid="feature-toggle" />
                                        {' '}<strong>{feature.title}</strong> <span className="hint">{isCore ? 'always installed' : formatBytes(feature.bytes)}</span>
                                    </label>
                                    <span className="hint">{feature.summary}</span>
                                    {[...new Set([...feature.requires, ...feature.dependsOn])].filter((dep) => dep !== CORE).length > 0 && (
                                        <span className="hint">Needs {[...new Set([...feature.requires, ...feature.dependsOn])].filter((dep) => dep !== CORE).map((dep) => titleOf(data, dep)).join(', ')}.</span>
                                    )}
                                    {missing.length > 0 && (
                                        <span className="settings-danger" role="alert" data-testid="missing-dependency">
                                            {feature.title} needs {missing.map((dep) => titleOf(data, dep)).join(' and ')}, which {missing.length === 1 ? 'is' : 'are'} off. Turn {missing.length === 1 ? 'it' : 'them'} on first; this page never does it for you.
                                        </span>
                                    )}
                                    {on && !isCore && dependents.length > 0 && <span className="hint">{dependents.map((id) => titleOf(data, id)).join(' and ')} need{dependents.length === 1 ? 's' : ''} this.</span>}
                                    {feature.system.length > 0 && (
                                        <span className="hint" data-testid="system-needs">
                                            Needs tools on this machine: {feature.system.map((tool) => tool.name).join(', ')}. The installer does not install them; the first-run check tells you if one is missing.
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                    <p className="hint" data-testid="features-total">Installed size with this choice: {formatBytes(total)}.</p>
                </>
            )}
            <StepNav onBack={() => go('where')} onNext={next} nextDisabled={!data} />
        </StepFrame>
    );
}
