/**
 * The reset inventory (#335, documentation/data_reset.md): every table the
 * schema creates is classified and has a valid owner, the deletion plans are
 * foreign-key ordered, every cross-feature reference has a stated policy, and
 * every statement a plan can run is valid on the live engine (SQLite or
 * Postgres). Nothing here removes data that has rows: the statements run
 * against an empty throwaway database or schema.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-reset-inventory-'));
process.env.GOOBSTER_DATA_DIR = path.join(ROOT, 'data');
process.env.GOOBSTER_DB_PATH = path.join(ROOT, 'test.sqlite');

const db = require('@goobster/core/db');
const featureInventory = require('@goobster/core/features/inventory');
const backupService = require('@goobster/core/services/backupService');
const resourceEventService = require('@goobster/core/services/resourceEventService');
const inventory = require('@goobster/core/db/resetInventory');
const reset = require('@goobster/core/db/reset');

const DATA = path.join(ROOT, 'data');
const CACHE = path.join(ROOT, 'cache');
const fixtureInventory = () => inventory.buildInventory({ dataDir: DATA, cacheDir: CACHE });

afterAll(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('the table inventory', () => {
    const real = fixtureInventory();
    const schemaTables = inventory.parseSchema();

    test('every table schema.sql creates is classified with a valid owner, exactly once', () => {
        expect(schemaTables.length).toBeGreaterThan(100);
        const names = schemaTables.map(table => table.name);
        expect(new Set(names).size).toBe(names.length);
        expect(real.tables.map(table => table.name).sort()).toEqual([...names].sort());
        for (const table of real.tables) {
            expect(featureInventory.FEATURE_IDS).toContain(table.owner);
        }
    });

    test('every classified table exists in the live database, and nothing application-shaped is left unclassified', async () => {
        const live = (await db.listTables()).filter(name => !inventory.VEC_TABLE_RE.test(name));
        const classified = new Set(real.order);
        for (const name of real.order) expect(live).toContain(name);
        const stray = live.filter(name => !classified.has(name));
        expect(stray).toEqual([]);
    });

    test('the deletion order is children first on every foreign key', () => {
        const position = new Map(real.order.map((name, index) => [name, index]));
        for (const table of real.tables) {
            for (const ref of table.references) {
                if (ref.refTable === table.name) continue;
                expect(position.get(table.name)).toBeLessThan(position.get(ref.refTable));
            }
        }
    });

    test('a table without an owner, and a foreign-key cycle, are refused', () => {
        expect(() => inventory.buildInventory({
            dataDir: DATA, cacheDir: CACHE, schemaSql: 'CREATE TABLE brand_new_unclassified_table (id INTEGER PRIMARY KEY);'
        })).toThrow(expect.objectContaining({ code: 'UNCLASSIFIED_TABLE' }));
        const cycle = [
            { name: 'a', columns: ['id', 'bId'], references: [{ column: 'bId', refTable: 'b', refColumn: 'id', onDelete: '' }] },
            { name: 'b', columns: ['id', 'aId'], references: [{ column: 'aId', refTable: 'a', refColumn: 'id', onDelete: '' }] }
        ];
        expect(() => inventory.deletionOrder(cycle)).toThrow(expect.objectContaining({ code: 'INVENTORY_CYCLE' }));
        const selfReference = [{ name: 'tree', columns: ['id', 'parentId'], references: [{ column: 'parentId', refTable: 'tree', refColumn: 'id', onDelete: '' }] }];
        expect(inventory.deletionOrder(selfReference)).toEqual(['tree']);
    });

    test('the kept and recreated rows name real tables and nothing overlaps', () => {
        const names = new Set(real.order);
        for (const table of [...Object.keys(inventory.INSTANCE_KEPT), ...Object.keys(inventory.INSTANCE_RECREATED)]) {
            expect(names.has(table)).toBe(true);
        }
        const kept = Object.keys(inventory.INSTANCE_KEPT);
        const recreated = Object.keys(inventory.INSTANCE_RECREATED);
        expect(kept.filter(table => recreated.includes(table))).toEqual([]);
        expect(kept.sort()).toEqual(['data_migrations', 'operator_audit']);
        expect(recreated.sort()).toEqual(['instance_state', 'self_docs']);
    });
});

describe('cross-feature references', () => {
    const real = fixtureInventory();

    test('every foreign key that crosses an owner has a stated policy, and no policy is stale', () => {
        const crossing = new Set();
        for (const table of real.tables) {
            for (const ref of table.references) {
                const parent = real.byName.get(ref.refTable);
                if (parent && parent.owner !== table.owner) crossing.add(`${table.name}.${ref.column}`);
            }
        }
        const stated = Object.keys(inventory.CROSS_OWNER_REFERENCES);
        const planned = [...crossing].filter(key => inventory.CROSS_OWNER_REFERENCES[key]);
        expect(stated.sort()).toEqual(planned.sort());
        for (const key of stated) {
            const [child, column] = key.split('.');
            const ref = real.byName.get(child).references.find(item => item.column === column);
            expect(ref.refTable).toBe(inventory.CROSS_OWNER_REFERENCES[key].parent);
            expect(['delete', 'set-null']).toContain(inventory.CROSS_OWNER_REFERENCES[key].policy);
        }
    });

    test('a feature purge covers every reference that points into the feature, and only plans what it can order', () => {
        for (const feature of featureInventory.FEATURE_IDS.filter(id => id !== inventory.CORE_ID)) {
            const plan = inventory.planScope(real, { scope: 'feature', feature });
            const own = new Set(plan.tables.cleared);
            const position = new Map();
            plan.steps.forEach((step, index) => { if (!position.has(step.table)) position.set(step.table, index); });
            for (const name of own) {
                for (const table of real.tables) {
                    for (const ref of table.references) {
                        if (ref.refTable !== name || table.name === name) continue;
                        // Whoever references an owned table is cleared or fixed earlier in the plan.
                        expect(position.has(table.name)).toBe(true);
                        expect(position.get(table.name)).toBeLessThanOrEqual(position.get(name));
                    }
                }
            }
        }
    });

    test('a reference nobody decided on is refused instead of guessed', () => {
        const fake = {
            ...real,
            tables: real.tables.map(table => (table.name === 'research_sources'
                ? { ...table, references: [...table.references, { column: 'sourceRef', refTable: 'tavern_adventures', refColumn: 'id', onDelete: '' }] }
                : table))
        };
        expect(() => inventory.planScope(fake, { scope: 'feature', feature: 'tavern' })).toThrow(expect.objectContaining({ code: 'UNPLANNED_REFERENCE' }));
    });
});

describe('shared rows and kinds', () => {
    const real = fixtureInventory();

    test('every shared-row rule names a table and columns that exist and a real feature', () => {
        const columnsOf = new Map(inventory.parseSchema().map(table => [table.name, table.columns]));
        for (const [feature, entries] of Object.entries(inventory.SHARED_ROWS)) {
            expect(featureInventory.FEATURE_IDS).toContain(feature);
            for (const entry of entries) {
                expect(columnsOf.has(entry.table)).toBe(true);
                expect(real.byName.get(entry.table).owner).not.toBe(feature);
                const used = entry.where.match(/\b[a-zA-Z]+(?=\s*(?:LIKE|=|IS|IN)\b)/g) || [];
                for (const column of used) expect(columnsOf.get(entry.table)).toContain(column);
                if (entry.files) expect(columnsOf.get(entry.table)).toContain(entry.files.column);
            }
        }
    });

    test('work kinds and resource kinds belong to real features and, for resources, to real kinds', () => {
        for (const owner of [...Object.values(inventory.WORK_KIND_OWNER), ...Object.values(inventory.RESOURCE_KIND_OWNER)]) {
            expect(featureInventory.FEATURE_IDS).toContain(owner);
        }
        for (const kind of Object.keys(inventory.RESOURCE_KIND_OWNER)) {
            expect(Object.keys(resourceEventService.KINDS)).toContain(kind);
        }
    });
});

describe('the file-set inventory', () => {
    const real = fixtureInventory();

    test('every backup file set is either owned by a feature or deliberately kept', () => {
        const ids = backupService.FILE_SETS.map(set => set.id).sort();
        const classified = [...Object.keys(inventory.BACKUP_SET_OWNER), ...Object.keys(inventory.BACKUP_SET_KEPT)].sort();
        expect(classified).toEqual(ids);
        for (const owner of Object.values(inventory.BACKUP_SET_OWNER)) expect(featureInventory.FEATURE_IDS).toContain(owner);
        expect(real.keptFileSets.map(set => set.id)).toEqual(['tavern-campaigns']);
    });

    test('file sets resolve against the installation roots passed in, not the process', () => {
        const other = inventory.buildInventory({ dataDir: path.join(ROOT, 'other-data'), cacheDir: path.join(ROOT, 'other-cache') });
        for (const set of other.fileSets) {
            expect(set.path.startsWith(path.join(ROOT, 'other-'))).toBe(true);
        }
        const music = other.fileSets.find(set => set.id === 'music-cache');
        expect(music.path).toBe(path.join(ROOT, 'other-cache', 'music'));
    });

    test('a set that escapes the roots, or contains a protected path, is refused', () => {
        const protectedPaths = [path.join(DATA, 'manager'), path.join(DATA, 'goobster.sqlite')];
        expect(() => inventory.assertFileSetsSafe(real.fileSets, protectedPaths, real.allowedRoots)).not.toThrow();
        expect(() => inventory.assertFileSetsSafe([{ id: 'x', path: path.join(ROOT, 'elsewhere') }], protectedPaths, real.allowedRoots))
            .toThrow(expect.objectContaining({ code: 'FILE_SET_UNSAFE' }));
        expect(() => inventory.assertFileSetsSafe([{ id: 'x', path: DATA }], protectedPaths, real.allowedRoots))
            .toThrow(expect.objectContaining({ code: 'FILE_SET_UNSAFE' }));
        expect(() => inventory.assertFileSetsSafe([{ id: 'x', path: path.join(DATA, 'manager') }], protectedPaths, real.allowedRoots))
            .toThrow(expect.objectContaining({ code: 'FILE_SET_UNSAFE' }));
    });

    test('the sandbox environment, self-docs and operator campaigns are never in a plan', () => {
        const plan = inventory.planScope(real, { scope: 'instance' });
        for (const set of plan.files) {
            expect(set.path).not.toContain(`${path.sep}venv`);
            expect(set.path).not.toContain(`${path.sep}overlay`);
            expect(set.path).not.toContain('self-docs');
            expect(set.path).not.toContain(path.join('tavern', 'campaigns'));
        }
    });
});

describe('scopes and confirmations', () => {
    const real = fixtureInventory();

    test('a scope is "instance" or one named feature; core and unknown features are refused', () => {
        expect(inventory.normalizeScope({ scope: 'instance' })).toEqual({ scope: 'instance' });
        expect(inventory.normalizeScope({ scope: 'feature', feature: 'tavern' })).toEqual({ scope: 'feature', feature: 'tavern' });
        expect(() => inventory.normalizeScope({ scope: 'feature', feature: 'core' })).toThrow(expect.objectContaining({ code: 'CORE_NOT_PURGEABLE' }));
        expect(() => inventory.normalizeScope({ scope: 'feature', feature: 'nonesuch' })).toThrow(expect.objectContaining({ code: 'UNKNOWN_FEATURE' }));
        expect(() => inventory.normalizeScope({ scope: 'feature', feature: '../x' })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }));
        expect(() => inventory.normalizeScope({ scope: 'feature' })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }));
        expect(() => inventory.normalizeScope({ scope: 'instance', feature: 'tavern' })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }));
        expect(() => inventory.normalizeScope({ scope: 'schema' })).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }));
        expect(() => inventory.normalizeScope(null)).toThrow(expect.objectContaining({ code: 'INVALID_SCOPE' }));
    });

    test('the text to type is the installation id, plus the feature for a purge', () => {
        expect(inventory.confirmationFor('inst-1', { scope: 'instance' })).toBe('inst-1');
        expect(inventory.confirmationFor('inst-1', { scope: 'feature', feature: 'tavern' })).toBe('inst-1:tavern');
    });

    test('the instance plan clears every table but the kept ones, and carries the vector index and every file set', () => {
        const plan = inventory.planScope(real, { scope: 'instance' });
        expect(plan.tables.cleared).toHaveLength(real.order.length - Object.keys(inventory.INSTANCE_KEPT).length);
        expect(plan.tables.cleared).not.toContain('operator_audit');
        expect(plan.derived.vectorIndex).toBe(true);
        expect(plan.files.map(set => set.id).sort()).toEqual(real.fileSets.map(set => set.id).sort());
        expect(inventory.planScope(real, { scope: 'instance' }).digest).toBe(plan.digest);
    });

    test('a feature plan names that feature\'s tables and no other feature\'s, and the digest tracks the scope', () => {
        const tavern = inventory.planScope(real, { scope: 'feature', feature: 'tavern' });
        expect(tavern.tables.cleared.length).toBeGreaterThan(0);
        for (const table of tavern.tables.cleared) expect(real.byName.get(table).owner).toBe('tavern');
        expect(tavern.files.map(set => set.id)).toEqual(['tavern-assets']);
        expect(inventory.tablesOf(tavern)).toEqual(expect.arrayContaining(tavern.tables.cleared));
        const economy = inventory.planScope(real, { scope: 'feature', feature: 'economy' });
        expect(economy.digest).not.toBe(tavern.digest);
        for (const id of ['discord', 'mail', 'discordActivity']) {
            expect(inventory.planScope(real, { scope: 'feature', feature: id }).empty).toBe(true);
        }
    });

    test('the description shows names and counts, never a row or an absolute path', () => {
        const plan = inventory.planScope(real, { scope: 'instance' });
        const described = inventory.describePlan(plan, { inventory: real, installationId: 'inst-1' });
        expect(described.confirm).toBe('inst-1');
        const text = JSON.stringify(described);
        expect(text).not.toContain(ROOT);
        expect(described.files.every(set => !path.isAbsolute(set.location))).toBe(true);
    });
});

describe('the plans run on the live engine', () => {
    test('the instance plan and every feature plan execute on an empty database, in a transaction', async () => {
        const real = fixtureInventory();
        const instance = await db.transaction(tx => reset.resetInstance(tx, real));
        expect(instance).toMatchObject({ scope: 'instance', recreated: ['instance_state'], paused: true });
        expect(instance.removed).toBeGreaterThanOrEqual(0);
        for (const feature of featureInventory.FEATURE_IDS.filter(id => id !== inventory.CORE_ID)) {
            const outcome = await db.transaction(tx => reset.purgeFeature(tx, real, feature));
            expect(outcome).toMatchObject({ scope: 'feature', feature, removed: 0 });
        }
        expect(await reset.referenceViolations(real)).toEqual([]);
    });

    test('verification of an empty instance finds only what is expected, and a dirty one is reported by name', async () => {
        const real = fixtureInventory();
        const clean = await reset.verifyReset({ inventory: real, scope: { scope: 'instance' } });
        expect(clean).toEqual({ ok: true, findings: [] });
        await db.run("INSERT INTO users (discordUsername, discordId, username) VALUES ('probe', '710000000000000001', 'probe')");
        const dirty = await reset.verifyReset({ inventory: real, scope: { scope: 'instance' } });
        expect(dirty.ok).toBe(false);
        expect(dirty.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ROWS_REMAINING', table: 'users', rows: 1 })]));
        expect(JSON.stringify(dirty)).not.toContain('probe');
        await db.run("DELETE FROM users WHERE discordId = '710000000000000001'");
    });
});
