import type { DatabaseConnectionBody, DatabaseReport } from '../../lib/types';

/**
 * What the person typed about the database (documentation/database_connection.md).
 * Everything but `password` may be kept in `sessionStorage` with the other
 * answers; the password lives in memory only (see answers.tsx).
 */
export type DatabaseAnswer = {
    engine: 'sqlite' | 'postgres';
    host: string;
    port: string;
    database: string;
    schema: string;
    user: string;
    password: string;
    /** '' means the default for the host: require for a remote server, prefer on this machine. */
    tlsMode: '' | 'disable' | 'prefer' | 'require' | 'verify-full';
    caFile: string;
};

export const EMPTY_DATABASE: DatabaseAnswer = {
    engine: 'sqlite', host: '', port: '5432', database: 'goobster', schema: 'public', user: 'goobster', password: '', tlsMode: '', caFile: ''
};

export const MANAGED_LATER = 'Available in a later version of this installer';

export const TLS_CHOICES: Array<{ value: DatabaseAnswer['tlsMode']; label: string; help: string }> = [
    { value: '', label: 'Default for this server', help: 'Encrypted and not checked for a server on another machine; tried encrypted first for one on this machine.' },
    { value: 'disable', label: 'disable: no encryption', help: 'Only on a network you trust completely.' },
    { value: 'prefer', label: 'prefer: encrypt if the server can', help: 'Falls back to no encryption only when the server does not offer TLS.' },
    { value: 'require', label: 'require: always encrypt', help: 'Encrypted; the server\'s certificate is not checked unless you give a CA file.' },
    { value: 'verify-full', label: 'verify-full: encrypt and check the server', help: 'Needs the CA file that signed the server\'s certificate.' }
];

export const PROVISION_ACTIONS: Array<{ id: string; label: string; help: string }> = [
    { id: 'create-role', label: 'Create the application role', help: 'LOGIN and CONNECT only: not a superuser, cannot create databases or roles. Its password is the one typed above.' },
    { id: 'create-database', label: 'Create the database', help: 'Owned by the application role.' },
    { id: 'create-schema', label: 'Create the schema', help: 'Only needed for a schema other than public.' },
    { id: 'create-extension.citext', label: 'Create the citext extension', help: 'Case-insensitive text, used for names and emails.' },
    { id: 'create-extension.vector', label: 'Create the vector extension (pgvector)', help: 'Memory recall. The server must already have the library installed.' },
    { id: 'grant', label: 'Grant the role what it needs', help: 'CONNECT on the database, USAGE and CREATE on the schema. Nothing else.' }
];

export function isLoopback(host: string): boolean {
    const value = host.trim().toLowerCase();
    return value === 'localhost' || value === '::1' || value === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(value);
}

export function connectionBody(answer: DatabaseAnswer): DatabaseConnectionBody {
    const port = Number(answer.port);
    return {
        host: answer.host.trim(),
        ...(answer.port.trim() && Number.isInteger(port) ? { port } : {}),
        database: answer.database.trim(),
        schema: answer.schema.trim() || 'public',
        user: answer.user.trim(),
        password: answer.password,
        ...(answer.tlsMode || answer.caFile.trim()
            ? { tls: { mode: answer.tlsMode || (isLoopback(answer.host) ? 'prefer' : 'require'), ...(answer.caFile.trim() ? { caFile: answer.caFile.trim() } : {}) } }
            : {})
    };
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
const NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

export type FormProblem = { field: string; message: string };

/** What can be told wrong without asking the server. */
export function connectionProblems(answer: DatabaseAnswer, { needPassword = true }: { needPassword?: boolean } = {}): FormProblem[] {
    const found: FormProblem[] = [];
    if (!answer.host.trim()) found.push({ field: 'db-host', message: 'Enter the server\'s host name or address.' });
    else if (/[/:@\s]/.test(answer.host.trim()) && !/^\[[0-9a-f:]+\]$/i.test(answer.host.trim())) found.push({ field: 'db-host', message: 'The host is a name or an address only; the port has its own box.' });
    const port = Number(answer.port);
    if (answer.port.trim() && (!Number.isInteger(port) || port < 1 || port > 65535)) found.push({ field: 'db-port', message: 'The port is a number from 1 to 65535 (PostgreSQL uses 5432).' });
    if (!answer.database.trim()) found.push({ field: 'db-database', message: 'Enter the database name.' });
    else if (!/^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/.test(answer.database.trim())) found.push({ field: 'db-database', message: 'The database name uses letters, digits, underscores, dashes and dollar signs.' });
    if (answer.schema.trim() && !NAME.test(answer.schema.trim())) found.push({ field: 'db-schema', message: 'The schema name uses letters, digits and underscores, and does not start with a digit.' });
    if (!answer.user.trim()) found.push({ field: 'db-user', message: 'Enter the user name Goobster signs in with.' });
    if (needPassword && answer.password === '') found.push({ field: 'db-password', message: 'Enter the password for that user (this page does not keep it).' });
    if (answer.tlsMode === 'verify-full' && !answer.caFile.trim()) found.push({ field: 'db-ca', message: 'verify-full needs the CA file that signed the server\'s certificate.' });
    if (answer.caFile.trim() && !ABSOLUTE.test(answer.caFile.trim())) found.push({ field: 'db-ca', message: 'The CA file needs a full path, like /etc/ssl/certs/ca.pem.' });
    if (answer.tlsMode === 'disable' && answer.caFile.trim()) found.push({ field: 'db-ca', message: 'A CA file does nothing when TLS is off; clear it or choose another mode.' });
    return found;
}

/** A sentence describing what the server may be asked and what a test of it shows. */
export const GUIDANCE = {
    sqlite: 'One machine, one process: SQLite is the right choice. It is a single file in the data folder, there is nothing to run or tune, and backing it up is copying the folder.',
    paired: 'You chose the layout where the bot and the portal run apart. They share the data through a server, so PostgreSQL is required; SQLite cannot be used with it.',
    heavy: 'Many Discord servers, or several of the heavy features (the exchange, long-term memory, research) used at the same time, are good reasons to consider PostgreSQL: several processes can write at once, and the database can live on its own machine.',
    existing: 'Choose PostgreSQL if you already run a server you trust and want Goobster\'s data kept there, or you plan to run the bot and the portal apart. Moving data that is already in SQLite is a separate step (the migration).'
};

export type Verdict = { tone: 'ok' | 'warn' | 'block'; text: string };

export function verdictOf(report: DatabaseReport): Verdict {
    if (!report.verdict.ok) return { tone: 'block', text: report.verdict.next === 'provision' ? 'The server is reachable but not ready: it needs the preparation below.' : 'This connection cannot be used yet.' };
    if (report.verdict.warnings.length > 0) return { tone: 'warn', text: 'This connection works. There are things worth reading below.' };
    return { tone: 'ok', text: 'This connection works.' };
}

/** Whether a probe report allows going on for an install or a connection. */
export function usable(report: DatabaseReport | null): boolean {
    if (!report || !report.verdict.ok || !report.schema) return false;
    return ['empty', 'goobster-older', 'goobster-current'].includes(report.schema.state);
}

function checksum(text: string): number {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
    return hash;
}

/** Changes whenever what a test was run for changes, without keeping the password. */
export function signatureOf(answer: DatabaseAnswer): string {
    return JSON.stringify([answer.host.trim(), answer.port.trim(), answer.database.trim(), answer.schema.trim() || 'public', answer.user.trim(), checksum(answer.password), answer.tlsMode, answer.caFile.trim()]);
}
