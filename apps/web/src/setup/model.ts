import type { HostConfigField, InstallSource, InstallSuggest } from '../lib/types';
import { buildChanges } from '../rooms/host/drafts';
import { OWNER_PASSWORD, typedSecret, type Answers } from './answers';
import { connectionBody, connectionProblems, dockerBody, dockerProblems } from './database/model';

export const OWNER_LOGIN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
export const PASSWORD_MIN = 15;
export const PASSWORD_MAX = 128;
export const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/;
export const PORTAL_SIGNIN_FIELDS = ['webapp.enabled', 'identity.nativeLogin'];

export type FieldMap = Map<string, HostConfigField>;
export type Problem = { field?: string; message: string; href?: string };

export const CORE = 'core';

/** The features the catalog turns on in a fresh installation, within what this release carries. */
export function recommendedFeatures(source: InstallSource | undefined): string[] {
    if (!source) return [];
    return source.features.filter((feature) => feature.id !== CORE && feature.freshDefault !== 'off').map((feature) => feature.id);
}

export function everyFeature(source: InstallSource | undefined): string[] {
    return source ? source.features.filter((feature) => feature.id !== CORE).map((feature) => feature.id) : [];
}

export function selectedFeatures(answers: Answers, source: InstallSource | undefined): string[] {
    return answers.features ?? recommendedFeatures(source);
}

export function missingDependencies(source: InstallSource, selected: ReadonlySet<string>, id: string): string[] {
    const feature = source.features.find((entry) => entry.id === id);
    if (!feature) return [];
    return [...new Set([...feature.requires, ...feature.dependsOn])].filter((dep) => dep !== CORE && !selected.has(dep));
}

export function dependentsOf(source: InstallSource, id: string): string[] {
    const seen = new Set<string>();
    const visit = (current: string) => {
        for (const feature of source.features) {
            if (!seen.has(feature.id) && (feature.requires.includes(current) || feature.dependsOn.includes(current))) {
                seen.add(feature.id);
                visit(feature.id);
            }
        }
    };
    visit(id);
    return [...seen];
}

export function titleOf(source: InstallSource | undefined, id: string): string {
    return source?.features.find((feature) => feature.id === id)?.title || id;
}

export function hasDiscordToken(answers: Answers, fields: FieldMap): boolean {
    return typedSecret(answers.fields['discord.token']) || answers.reenter.includes('discord.token') || fields.get('discord.token')?.present === true;
}

/** Discord connected means the bot serves the portal itself; none means the portal runs on its own. */
export function layoutFor(answers: Answers, fields: FieldMap): 'lite' | 'standalone' {
    if (answers.layout !== 'auto') return answers.layout;
    return hasDiscordToken(answers, fields) ? 'lite' : 'standalone';
}

export function rootsFor(answers: Answers, suggest: InstallSuggest): Record<string, string> {
    const pick = (role: 'code' | 'cache' | 'logs' | 'uploads') => (answers.roots[role] || suggest.roots[role].path);
    return {
        code: pick('code'),
        data: suggest.roots.data.path,
        config: suggest.roots.config.path,
        cache: pick('cache'),
        logs: pick('logs'),
        uploads: pick('uploads'),
        managerStore: suggest.roots.managerStore.path
    };
}

/** The configuration changes the wizard sends: what was typed, plus what the chosen layout needs to run. */
export function configChanges(answers: Answers, fields: FieldMap, layout: 'lite' | 'standalone'): { entries: Array<{ id: string; value: unknown }>; problem: string | null } {
    const built = buildChanges(fields, { ...answers.fields });
    const entries: Array<{ id: string; value: unknown }> = [];
    for (const change of built.changes) {
        if (change.action === 'set') entries.push({ id: String(change.id), value: change.value });
    }
    // A setting the environment controls is the operator's: the manager refuses to record a file value that would have no effect.
    const implied = (id: string) => !entries.some((entry) => entry.id === id) && fields.get(id)?.envControlled !== true;
    if (implied('webapp.enabled')) entries.push({ id: 'webapp.enabled', value: true });
    if (answers.owner.create && implied('identity.nativeLogin')) entries.push({ id: 'identity.nativeLogin', value: true });
    void layout;
    return { entries, problem: built.problem };
}

export function installInput(params: {
    answers: Answers; suggest: InstallSuggest; source: InstallSource | undefined; fields: FieldMap;
}): Record<string, unknown> {
    const { answers, suggest, source, fields } = params;
    const layout = layoutFor(answers, fields);
    return {
        ownerLabel: answers.label.trim() || 'Goobster',
        source: answers.sourceDir.trim(),
        features: selectedFeatures(answers, source),
        layout,
        roots: rootsFor(answers, suggest),
        database: databaseInput(answers),
        ...(answers.allowUnsigned ? { release: { allowUnsigned: true } } : {}),
        config: configChanges(answers, fields, layout).entries,
        update: { mode: answers.updateMode },
        registerService: false
    };
}

/** The `database` answer: SQLite, or the connection to an existing server (the password is in this object only until the plan is made). */
export function databaseInput(answers: Answers): Record<string, unknown> {
    if (answers.database.engine !== 'postgres') return { engine: 'sqlite' };
    return answers.database.source === 'docker'
        ? { engine: 'postgres', docker: dockerBody(answers.database.docker) }
        : { engine: 'postgres', connection: connectionBody(answers.database) };
}

export function databaseProblems(answers: Answers, layout: string): Problem[] {
    const href = '#/setup/database';
    if (answers.database.engine === 'postgres' && answers.database.source === 'docker') {
        return dockerProblems(answers.database.docker).map((problem) => ({ field: problem.field, message: problem.message, href }));
    }
    if (answers.database.engine === 'postgres') {
        return connectionProblems(answers.database).map((problem) => ({
            field: problem.field,
            message: problem.field === 'db-password' && answers.reenter.includes('database.password') ? 'Enter the database password again: this page no longer holds it.' : problem.message,
            href
        }));
    }
    return layout === 'paired' ? [{ message: 'The paired layout needs PostgreSQL; SQLite cannot be used with it.', href }] : [];
}

export function ownerInput(answers: Answers): Record<string, unknown> {
    return {
        loginName: answers.owner.loginName.trim(),
        password: answers.owner.password,
        ...(answers.owner.displayName.trim() ? { displayName: answers.owner.displayName.trim() } : {})
    };
}

export function ownerProblems(answers: Answers, fields: FieldMap): Problem[] {
    const problems: Problem[] = [];
    const owner = answers.owner;
    if (!owner.create) {
        if (!hasDiscordToken(answers, fields)) {
            problems.push({ field: 'owner-create', message: 'Nobody could sign in. Create the owner account, or connect Discord.' });
        }
        return problems;
    }
    const login = owner.loginName.trim();
    if (!OWNER_LOGIN.test(login) || /^\d+$/.test(login) || login.startsWith('usr_')) {
        problems.push({ field: 'owner-login', message: 'The login name is 3 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.' });
    }
    if (owner.password.length === 0) {
        problems.push({ field: 'owner-password', message: answers.reenter.includes(OWNER_PASSWORD) ? 'Enter the password again: this page no longer holds it.' : 'Choose a password for the owner account.' });
    } else if (owner.password.length < PASSWORD_MIN || owner.password.length > PASSWORD_MAX) {
        problems.push({ field: 'owner-password', message: `The password needs ${PASSWORD_MIN} to ${PASSWORD_MAX} characters; a phrase works well.` });
    } else if (login && owner.password.toLowerCase().includes(login.toLowerCase())) {
        problems.push({ field: 'owner-password', message: 'The password must not contain the login name.' });
    } else if (owner.password !== owner.repeat) {
        problems.push({ field: 'owner-repeat', message: 'The two passwords are not the same.' });
    }
    return problems;
}

export function fieldProblems(answers: Answers, fields: FieldMap, ids: string[]): Problem[] {
    const only: Record<string, (typeof answers.fields)[string]> = {};
    for (const id of ids) if (answers.fields[id]) only[id] = answers.fields[id];
    const built = buildChanges(fields, only);
    if (!built.problem) return [];
    const [id, ...rest] = built.problem.split(': ');
    return [{ field: `host-field-${id}`, message: `${id}: ${rest.join(': ')}` }];
}

export function pathProblem(label: string, value: string, field: string): Problem | null {
    if (!value.trim()) return { field, message: `Choose where ${label} goes.` };
    if (!ABSOLUTE.test(value.trim())) return { field, message: `${label[0].toUpperCase()}${label.slice(1)} needs a full path, like /opt/goobster.` };
    if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return { field, message: 'A path cannot contain "..".' };
    return null;
}

export const LAYOUT_TEXT: Record<string, string> = {
    lite: 'One program: the Discord bot serves the web portal itself.',
    standalone: 'The web portal runs on its own, with no Discord connection.',
    paired: 'The bot and the portal run apart, against Postgres.'
};

export function summarizeRoots(roots: Record<string, string> | null | undefined): Array<[string, string]> {
    if (!roots) return [];
    const names: Record<string, string> = {
        code: 'Program files', data: 'Data', config: 'Settings file', cache: 'Cache', logs: 'Logs', uploads: 'Uploads', managerStore: 'Manager records'
    };
    return Object.keys(names).filter((role) => roots[role]).map((role) => [names[role], roots[role]]);
}
