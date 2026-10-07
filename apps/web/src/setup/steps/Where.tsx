import { useEffect, useState } from 'react';
import { useAnswers } from '../answers';
import { useSource, useSuggest } from '../data';
import { pathProblem } from '../model';
import { describeError, ErrorSummary, formatBytes, insideBase, StepFrame, StepNav, type Problem } from '../ui';
import type { StepProps } from './order';

const EDITABLE = [
    { role: 'code', label: 'Program files', help: 'The program itself, in versioned folders so an update can be undone.' },
    { role: 'cache', label: 'Cache', help: 'Downloaded and generated files that can be rebuilt.' },
    { role: 'logs', label: 'Logs', help: 'What each process writes while it runs; this is where to look if something fails.' },
    { role: 'uploads', label: 'Uploads', help: 'Files people attach in the portal.' }
] as const;

/** Which release to install and where on this machine its folders go. */
export function Where({ go }: StepProps) {
    const { answers, update } = useAnswers();
    const suggest = useSuggest();
    const [problems, setProblems] = useState<Problem[]>([]);
    const source = useSource(answers.sourceDir);
    const data = suggest.data;

    useEffect(() => {
        if (!data) return;
        update((previous) => {
            const roots = { ...previous.roots };
            let changed = false;
            for (const { role } of EDITABLE) {
                if (!roots[role]) { roots[role] = data.roots[role].path; changed = true; }
            }
            const sourceDir = previous.sourceDir || (data.sources[0]?.dir ?? '');
            if (sourceDir !== previous.sourceDir) changed = true;
            return changed ? { ...previous, roots, sourceDir } : previous;
        });
    }, [data, update]);

    function next() {
        const found: Problem[] = [];
        if (!answers.sourceDir.trim()) found.push({ field: 'where-source', message: 'Choose the release to install, or type the folder it is in.' });
        else if (source.isError) found.push({ field: 'where-source', message: describeError(source.error).message });
        for (const { role, label } of EDITABLE) {
            const problem = pathProblem(label.toLowerCase(), answers.roots[role], `where-${role}`);
            if (problem) found.push(problem);
            else if (data && !insideBase(answers.roots[role], data.bases.map((base) => base.path), data.separator) && data.roots[role].allowed !== undefined && !data.roots[role].fixed) {
                found.push({ field: `where-${role}`, message: `${label} must be inside one of the folders this page may install into (listed below).` });
            }
        }
        setProblems(found);
        if (found.length === 0) go('features');
    }

    const needed = source.data ? source.data.totalBytes : null;
    const freeCode = data?.roots.code.freeBytes;
    return (
        <StepFrame id="where" title="Where should Goobster go?"
            lead="Pick the release to install and the folders it uses. The defaults are safe; change them only if you want Goobster on another disk.">
            <ErrorSummary problems={problems} />
            {suggest.isPending && <p role="status" className="hint">Looking at this machine…</p>}
            {suggest.isError && <p role="alert" className="settings-danger">{describeError(suggest.error).message}</p>}
            {data && (
                <>
                    <fieldset className="wizard-fieldset">
                        <legend>Release</legend>
                        {data.sources.length > 0 && (
                            <div role="radiogroup" aria-label="Releases found on this machine">
                                {data.sources.map((entry) => (
                                    <label key={entry.dir} className="wizard-choice">
                                        <input type="radio" name="release" checked={answers.sourceDir === entry.dir}
                                            onChange={() => update((previous) => ({ ...previous, sourceDir: entry.dir, features: null }))} data-testid="release-choice" />
                                        {' '}Goobster {entry.version} <span className="hint">({formatBytes(entry.totalBytes)} · {entry.dir})</span>
                                    </label>
                                ))}
                            </div>
                        )}
                        <div className="wizard-field">
                            <label htmlFor="where-source">{data.sources.length > 0 ? 'Or another folder' : 'Folder with the release'}</label>
                            <input id="where-source" className="input" value={answers.sourceDir} spellCheck={false}
                                onChange={(event) => update((previous) => ({ ...previous, sourceDir: event.target.value, features: null }))} data-testid="where-source" />
                            <span className="hint">The folder a release was unpacked into (it holds a <code>release-manifest.json</code>).</span>
                        </div>
                        <div role="status" aria-live="polite" data-testid="source-status">
                            {source.isFetching && <span className="hint">Checking that folder…</span>}
                            {source.data && <span className="hint">Goobster {source.data.version} for {source.data.target}, {formatBytes(source.data.totalBytes)} in {source.data.features.length} parts.</span>}
                            {source.isError && <span className="settings-danger">{describeError(source.error).message}</span>}
                        </div>
                        <label className="wizard-choice">
                            <input type="checkbox" checked={answers.allowUnsigned}
                                onChange={(event) => update((previous) => ({ ...previous, allowUnsigned: event.target.checked }))} data-testid="allow-unsigned" />
                            {' '}This release is not signed (advanced: only for a build you made yourself)
                        </label>
                    </fieldset>
                    <fieldset className="wizard-fieldset" data-testid="where-updates">
                        <legend>Updates</legend>
                        <div className="wizard-field">
                            <label htmlFor="where-update-mode">Should the manager look for newer releases?</label>
                            <select id="where-update-mode" className="input" value={answers.updateMode} data-testid="where-update-mode"
                                onChange={(event) => update((previous) => ({ ...previous, updateMode: event.target.value as typeof previous.updateMode }))}>
                                <option value="off">Off</option>
                                <option value="check">Check (say so when one is available)</option>
                                <option value="download">Download (check, then fetch and verify it)</option>
                                <option value="apply">Apply (install it inside an update window)</option>
                            </select>
                            <span className="hint">You can change this later in the Host room. An update never touches your settings or data.</span>
                        </div>
                    </fieldset>
                    <fieldset className="wizard-fieldset">
                        <legend>Folders</legend>
                        {EDITABLE.map(({ role, label, help }) => (
                            <div key={role} className="wizard-field">
                                <label htmlFor={`where-${role}`}>{label}</label>
                                <input id={`where-${role}`} className="input" value={answers.roots[role]} spellCheck={false}
                                    onChange={(event) => update((previous) => ({ ...previous, roots: { ...previous.roots, [role]: event.target.value } }))} data-testid={`where-${role}`} />
                                <span className="hint">{help}{role === 'code' && freeCode != null ? ` ${formatBytes(freeCode)} free here${needed ? `; the release needs about ${formatBytes(needed * 2)} while it is copied` : ''}.` : ''}</span>
                            </div>
                        ))}
                        <p className="hint">Your data, settings file and the manager&apos;s records stay where this manager keeps them; the next steps show them.</p>
                    </fieldset>
                    <div className="wizard-callout" data-testid="allowed-bases">
                        <strong>Folders this page may install into</strong>
                        <ul>
                            {data.bases.map((base) => <li key={base.path}><code>{base.path}</code> <span className="hint">{formatBytes(base.freeBytes)} free</span></li>)}
                        </ul>
                        <p className="hint">Anywhere else is refused so a browser session cannot write across the machine. The command line is not limited this way.</p>
                    </div>
                    {data.candidates.length > 0 && (
                        <p className="hint" data-testid="existing-found">
                            An existing Goobster was found at <code>{data.candidates[0].code}</code>. This setup does not touch it; adopt it from the command line if you want the manager to take it over.
                        </p>
                    )}
                </>
            )}
            <StepNav onBack={() => go('welcome')} onNext={next} nextDisabled={!data} />
        </StepFrame>
    );
}
