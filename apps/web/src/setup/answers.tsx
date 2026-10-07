import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FieldDraft } from '../rooms/host/FieldControl';
import { EMPTY_DATABASE, EMPTY_DOCKER, EMPTY_NATIVE, type DatabaseAnswer } from './database/model';

/**
 * Everything the person has typed in the wizard. Non-secret answers are kept
 * in `sessionStorage` (this tab only, gone when it closes) so a reload or the
 * Back button returns to a filled form. A secret - an API key, the owner's
 * password - lives in this module's memory only: it is never written to
 * storage, a cookie or the URL, and it is dropped the moment the manager has
 * it in a plan (documentation/setup_wizard.md, "Secrets").
 */
export type OwnerAnswer = { create: boolean; loginName: string; displayName: string; password: string; repeat: string };

export type Answers = {
    label: string;
    sourceDir: string;
    allowUnsigned: boolean;
    layout: 'auto' | 'lite' | 'standalone';
    roots: { code: string; cache: string; logs: string; uploads: string };
    features: string[] | null;
    fields: Record<string, FieldDraft>;
    instanceDefaults: Record<string, FieldDraft>;
    owner: OwnerAnswer;
    /** SQLite, or an existing PostgreSQL server; its password is kept in memory only. */
    database: DatabaseAnswer;
    /** Secret field ids the person typed that the page no longer holds: they must be entered again. */
    reenter: string[];
};

export const EMPTY_OWNER: OwnerAnswer = { create: true, loginName: '', displayName: '', password: '', repeat: '' };

export const EMPTY_ANSWERS: Answers = {
    label: '',
    sourceDir: '',
    allowUnsigned: false,
    layout: 'auto',
    roots: { code: '', cache: '', logs: '', uploads: '' },
    features: null,
    fields: {},
    instanceDefaults: {},
    owner: EMPTY_OWNER,
    database: EMPTY_DATABASE,
    reenter: []
};

const STORAGE_KEY = 'goobster-setup-answers';
/** The id the owner's password goes by in `reenter` (it is not a catalog field). */
export const OWNER_PASSWORD = 'owner.password';

/** The id the database password goes by in `reenter`. */
export const DATABASE_PASSWORD = 'database.password';

function secretFree(answers: Answers, secretIds: ReadonlySet<string>): Omit<Answers, 'owner' | 'database'> & { owner: Omit<OwnerAnswer, 'password' | 'repeat'>; database: Omit<DatabaseAnswer, 'password'> } {
    const fields: Record<string, FieldDraft> = {};
    for (const [id, draft] of Object.entries(answers.fields)) if (!secretIds.has(id)) fields[id] = draft;
    const { password: _password, repeat: _repeat, ...owner } = answers.owner;
    const { password: _databasePassword, ...database } = answers.database;
    return { ...answers, fields, owner, database };
}

function load(key: string): Answers {
    try {
        const raw = window.sessionStorage.getItem(key);
        if (!raw) return EMPTY_ANSWERS;
        const parsed = JSON.parse(raw) as Partial<Answers>;
        return {
            ...EMPTY_ANSWERS,
            ...parsed,
            roots: { ...EMPTY_ANSWERS.roots, ...(parsed.roots || {}) },
            owner: { ...EMPTY_OWNER, ...(parsed.owner || {}), password: '', repeat: '' },
            database: { ...EMPTY_DATABASE, ...(parsed.database || {}), docker: { ...EMPTY_DOCKER, ...(parsed.database?.docker || {}) }, native: { ...EMPTY_NATIVE, ...(parsed.database?.native || {}) }, password: '' },
            fields: parsed.fields || {},
            instanceDefaults: parsed.instanceDefaults || {},
            reenter: Array.isArray(parsed.reenter) ? parsed.reenter : []
        };
    } catch {
        return EMPTY_ANSWERS;
    }
}

type Store = {
    answers: Answers;
    update: (change: (previous: Answers) => Answers) => void;
    setField: (id: string, draft: FieldDraft | null) => void;
    setDefault: (id: string, draft: FieldDraft | null) => void;
    /** Tell the store which catalog ids are secrets (from the configuration report). */
    registerSecrets: (ids: string[]) => void;
    /** The manager has the secrets typed so far: forget them here and remember that they must be entered again. */
    dropSecrets: () => void;
    reset: () => void;
};

const Context = createContext<Store | null>(null);

export function AnswersProvider({ storageKey = STORAGE_KEY, children }: { storageKey?: string; children: ReactNode }) {
    const [answers, setAnswers] = useState<Answers>(() => load(storageKey));
    const secrets = useRef<Set<string>>(new Set());

    useEffect(() => {
        try {
            window.sessionStorage.setItem(storageKey, JSON.stringify(secretFree(answers, secrets.current)));
        } catch { /* storage is optional */ }
    }, [answers, storageKey]);

    const update = useCallback((change: (previous: Answers) => Answers) => setAnswers(change), []);
    const setField = useCallback((id: string, draft: FieldDraft | null) => setAnswers((previous) => {
        const fields = { ...previous.fields };
        if (draft === null) delete fields[id];
        else fields[id] = draft;
        const typedSecret = draft && draft.action === 'set' && typeof draft.value === 'string' && draft.value !== '';
        return { ...previous, fields, reenter: typedSecret ? previous.reenter.filter((entry) => entry !== id) : previous.reenter };
    }), []);
    const setDefault = useCallback((id: string, draft: FieldDraft | null) => setAnswers((previous) => {
        const instanceDefaults = { ...previous.instanceDefaults };
        if (draft === null) delete instanceDefaults[id];
        else instanceDefaults[id] = draft;
        return { ...previous, instanceDefaults };
    }), []);
    const registerSecrets = useCallback((ids: string[]) => { secrets.current = new Set([...secrets.current, ...ids]); }, []);
    const dropSecrets = useCallback(() => setAnswers((previous) => {
        const fields: Record<string, FieldDraft> = {};
        const reenter = new Set(previous.reenter);
        for (const [id, draft] of Object.entries(previous.fields)) {
            if (secrets.current.has(id) && draft.action === 'set') reenter.add(id);
            else fields[id] = draft;
        }
        if (previous.owner.password) reenter.add(OWNER_PASSWORD);
        if (previous.database.password) reenter.add(DATABASE_PASSWORD);
        return { ...previous, fields, owner: { ...previous.owner, password: '', repeat: '' }, database: { ...previous.database, password: '' }, reenter: [...reenter] };
    }), []);
    const reset = useCallback(() => {
        try { window.sessionStorage.removeItem(storageKey); } catch { /* ignore */ }
        setAnswers(EMPTY_ANSWERS);
    }, [storageKey]);

    const value = useMemo<Store>(() => ({ answers, update, setField, setDefault, registerSecrets, dropSecrets, reset }),
        [answers, update, setField, setDefault, registerSecrets, dropSecrets, reset]);
    return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAnswers(): Store {
    const value = useContext(Context);
    if (!value) throw new Error('No answers provider.');
    return value;
}

/** Whether a draft carries a typed secret. */
export function typedSecret(draft: FieldDraft | undefined): boolean {
    return Boolean(draft && draft.action === 'set' && typeof draft.value === 'string' && draft.value !== '');
}
