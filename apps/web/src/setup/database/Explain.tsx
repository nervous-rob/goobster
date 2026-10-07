import type { DatabaseStatus } from '../../lib/types';
import { DocLink } from '../../rooms/host/shared';
import { GUIDANCE, type DatabaseAnswer } from './model';

/** Which engine fits which workload. Said in terms of how it is run, not of a number of users. */
export function EngineGuidance({ layout, engine }: { layout: string; engine: DatabaseAnswer['engine'] }) {
    return (
        <div className="wizard-callout" data-testid="engine-guidance">
            <strong>Which should I choose?</strong>
            <ul className="wizard-list">
                <li data-testid="guidance-sqlite"><strong>One machine, one process (the default): SQLite.</strong> {GUIDANCE.sqlite}</li>
                <li data-testid="guidance-paired" data-current={layout === 'paired' ? 'true' : 'false'}><strong>The bot and the portal run apart: PostgreSQL is required.</strong> {GUIDANCE.paired}</li>
                <li data-testid="guidance-heavy"><strong>Many servers, or several heavy features at once: consider PostgreSQL.</strong> {GUIDANCE.heavy}</li>
            </ul>
            {layout === 'paired' && engine === 'sqlite' && (
                <p role="alert" className="settings-danger" data-testid="paired-needs-postgres">This layout cannot use SQLite. Choose PostgreSQL, or change the layout.</p>
            )}
        </div>
    );
}

/** Where PostgreSQL's own settings live: not here. Read-only on purpose. */
export function ServerStorageBlock({ host, port, database, schema, local }: { host: string; port: string | number; database: string; schema: string; local: boolean }) {
    return (
        <section className="wizard-callout" aria-labelledby="db-storage-title" data-testid="db-storage-block">
            <h3 id="db-storage-title" className="section-title">Where the data is stored</h3>
            <dl className="wizard-facts">
                <div className="wizard-fact"><dt>Server</dt><dd><code data-testid="db-storage-server">{host || 'not set'}{port ? `:${port}` : ''}</code> {local ? <span className="hint">(this machine)</span> : <span className="hint">(another machine)</span>}</dd></div>
                <div className="wizard-fact"><dt>Database</dt><dd><code>{database || 'not set'}</code>, schema <code>{schema || 'public'}</code></dd></div>
                <div className="wizard-fact"><dt>Data directory, listen address, port</dt><dd>set on the server; read-only here</dd></div>
            </dl>
            <p className="hint">
                The server belongs to whoever runs it. Goobster uses one database and one schema on it and changes nothing else: not the server&apos;s data
                directory, the address it listens on, its port, its memory settings or its other databases. To change those, change the server, then
                edit the connection here. Uninstalling Goobster never drops this database or its tables.
            </p>
        </section>
    );
}

/** The three different things a person may mean by "database maintenance". */
export function ThreeKinds() {
    return (
        <section className="wizard-callout" aria-labelledby="db-kinds-title" data-testid="db-three-kinds">
            <h3 id="db-kinds-title" className="section-title">Three different jobs</h3>
            <dl className="wizard-facts">
                <div className="wizard-fact"><dt>Connection setup</dt><dd>Telling Goobster where the server is and how to sign in: this page. It never moves data.</dd></div>
                <div className="wizard-fact"><dt>Schema update</dt><dd>Adding the tables and columns this release needs to a database Goobster already owns. Safe to repeat; it never runs on a schema that holds anything else.</dd></div>
                <div className="wizard-fact"><dt>PostgreSQL server upgrade</dt><dd>Moving the server itself to a newer major version. That is the administrator&apos;s job, outside Goobster; <DocLink slug="postgres" hash="upgrading-the-server">read how in the PostgreSQL guide</DocLink>.</dd></div>
            </dl>
        </section>
    );
}

/** Who owns the storage, and what a failure of it means. */
export function StorageOwnership({ engine, docker = false }: { engine: 'sqlite' | 'postgres'; docker?: boolean }) {
    if (docker) {
        return <p className="hint" data-testid="storage-owner">The database runs in a container this installer creates, with its data in a Docker volume or a folder you chose. Uninstalling keeps that data unless you ask for it to be removed, and then removes only what the installer created. A Goobster backup does not contain it: back it up with the backup command, which reads it through <code>pg_dump</code>.</p>;
    }
    return engine === 'sqlite' ? (
        <p className="hint" data-testid="storage-owner">The database is a file in this installation&apos;s data folder. The installation owns it: backups copy it and a full uninstall can remove it.</p>
    ) : (
        <p className="hint" data-testid="storage-owner">The database lives on a server you run. The installation does not own it: a backup of Goobster does not contain it, and an uninstall never drops it.</p>
    );
}

/** What to do for each way the database can fail, in plain words. */
export function FailureHelp({ status }: { status: DatabaseStatus | undefined }) {
    return (
        <details className="wizard-details" data-testid="db-failure-help">
            <summary>If the database cannot be reached</summary>
            <ul className="wizard-list">
                <li><strong>The server is down or unreachable:</strong> the application keeps trying and recovers by itself when it is back. Start the server; check the host and port.</li>
                <li><strong>The password changed:</strong> connect again below with the new password. The old connection stays in use until you do.</li>
                <li><strong>The schema is behind:</strong> use &ldquo;Update the schema&rdquo;; it brings an older Goobster schema up to date without losing anything.</li>
                {status?.engine === 'sqlite' && <li><strong>The file is damaged:</strong> Repair opens it again; restore a backup if it cannot be read.</li>}
            </ul>
        </details>
    );
}
