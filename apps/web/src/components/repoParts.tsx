/**
 * Small repository pieces shared by the project Code view and the chat's
 * tool cards: a coloured unified diff and a CI verdict badge. Kept apart
 * from ProjectRepos so chat does not pull the projects room into its chunk.
 */

export type CiFailure = { name: string; conclusion: string; url: string | null; summary: string };
export type CiPayload = { ref: string; state: 'success' | 'failure' | 'pending' | 'none'; total: number; passed: number; failing: CiFailure[]; pending: string[]; notOnGitHub?: boolean };

export function ciBadge(ci: Pick<CiPayload, 'state' | 'failing' | 'pending' | 'passed' | 'total'> | null | undefined) {
    if (!ci || ci.state === 'none') return <span className="hint">no CI</span>;
    if (ci.state === 'success') return <span title={`${ci.passed} checks passed`}>✅ passing</span>;
    if (ci.state === 'pending') return <span title={ci.pending.join(', ')}>🟡 running</span>;
    return <span title={ci.failing.map((f) => f.name).join(', ')}>❌ {ci.failing.length} failing</span>;
}

/** A unified diff from the server, coloured by line. */
export function DiffView({ text }: { text: string }) {
    return (
        <pre className="obs-diff">
            {text.split('\n').map((line, index) => (
                <span
                    key={index}
                    className={line.startsWith('+') && !line.startsWith('+++') ? 'add'
                        : line.startsWith('-') && !line.startsWith('---') ? 'del' : ''}
                >{line}{'\n'}</span>
            ))}
        </pre>
    );
}
