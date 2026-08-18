/**
 * SQLite -> Postgres dialect translation (reactive port, Phase 2).
 *
 * The codebase's SQL is written natively for SQLite (the standards doc's
 * rule), and ~900 call sites go through the db facade. Rather than rewrite
 * every statement, the Postgres adapter translates SQL text once per
 * distinct statement (cached) at prepare time. Everything here is a pure
 * function of the SQL string, so the whole layer is unit-testable.
 *
 * Translation rules (DML):
 *  - '@name' params        -> $1..$n (order of first appearance)
 *  - datetime('now')       -> to_char UTC text (timestamps are stored as
 *    'YYYY-MM-DD HH:MM:SS' TEXT on both engines - the comparisons are
 *    lexicographic, so the text form must match exactly)
 *  - datetime('now', 'MOD') / datetime(expr, 'MOD') -> interval arithmetic
 *  - date('now')           -> to_char UTC date text
 *  - CURRENT_TIMESTAMP     -> the same to_char form (PG's CURRENT_TIMESTAMP
 *    is a timestamptz whose text form doesn't match SQLite's)
 *  - X = @p COLLATE NOCASE -> lower(X) = lower(@p); ORDER BY X COLLATE
 *    NOCASE -> lower(X); remaining COLLATE NOCASE stripped (schema-level
 *    NOCASE columns become CITEXT, which is case-insensitive by itself)
 *  - LIKE -> ILIKE (SQLite's LIKE is case-insensitive for ASCII)
 *  - mixed-case bare identifiers -> quoted (PG lowercases unquoted
 *    identifiers; guildId must stay guildId so row keys match JS reads.
 *    SQL keywords are single-cased and functions are lowercase, so mixed
 *    case reliably means "one of our identifiers/aliases")
 *
 * DDL adds: INTEGER PRIMARY KEY [AUTOINCREMENT] -> BIGINT identity,
 * INTEGER -> BIGINT, REAL -> DOUBLE PRECISION, BLOB -> BYTEA,
 * TEXT COLLATE NOCASE -> CITEXT, DEFAULT CURRENT_TIMESTAMP /
 * DEFAULT (datetime('now')) -> the to_char default.
 */

const PG_NOW_TEXT = "to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD HH24:MI:SS')";
const PG_TODAY_TEXT = "to_char((now() AT TIME ZONE 'utc'), 'YYYY-MM-DD')";

/**
 * Split SQL into alternating code / string-literal segments so replacements
 * never touch quoted text. Segments: { text, isString }.
 */
function segmentSql(sql) {
    const segments = [];
    let cur = '';
    let inString = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (!inString && ch === "'") {
            segments.push({ text: cur, isString: false });
            cur = "'";
            inString = true;
        } else if (inString && ch === "'") {
            if (sql[i + 1] === "'") { cur += "''"; i++; continue; }
            cur += "'";
            segments.push({ text: cur, isString: true });
            cur = '';
            inString = false;
        } else {
            cur += ch;
        }
    }
    if (cur.length > 0) segments.push({ text: cur, isString: inString });
    return segments;
}

/** Apply fn to every non-string segment. */
function mapCode(sql, fn) {
    return segmentSql(sql).map(seg => (seg.isString ? seg.text : fn(seg.text))).join('');
}

/** SQLite modifier ('-7 days', '+2 hours') -> PG interval expression. */
function modifierToInterval(mod) {
    const m = String(mod).trim().match(/^([+-]?)\s*([\d.]+)\s+(second|minute|hour|day|month|year)s?$/i);
    if (!m) return null;
    const sign = m[1] === '-' ? '-' : '+';
    return `${sign} interval '${m[2]} ${m[3].toLowerCase()}'`;
}

/**
 * Rewrite datetime()/date() calls. Runs on the WHOLE sql (needs to see the
 * quoted modifier strings), so it is careful to match only these forms.
 */
function rewriteDatetimeFns(sql) {
    // datetime('now') / datetime('now', 'MOD')
    sql = sql.replace(/\bdatetime\(\s*'now'\s*(?:,\s*'([^']*)'\s*)?\)/gi, (whole, mod) => {
        if (!mod) return PG_NOW_TEXT;
        const interval = modifierToInterval(mod);
        if (!interval) throw new Error(`Unsupported datetime modifier for Postgres: '${mod}'`);
        return `to_char((now() AT TIME ZONE 'utc') ${interval}, 'YYYY-MM-DD HH24:MI:SS')`;
    });
    // date('now')
    sql = sql.replace(/\bdate\(\s*'now'\s*\)/gi, PG_TODAY_TEXT);
    // date(expr) - truncate a TEXT timestamp to its date part
    sql = sql.replace(/\bdate\(\s*([\w$."]+)\s*\)/gi, (whole, expr) =>
        `to_char((${expr})::timestamp, 'YYYY-MM-DD')`);
    // datetime(expr, 'MOD') - expr is a TEXT timestamp column, @param, or $n
    sql = sql.replace(/\bdatetime\(\s*([\w@$."]+)\s*,\s*'([^']*)'\s*\)/gi, (whole, expr, mod) => {
        const interval = modifierToInterval(mod);
        if (!interval) throw new Error(`Unsupported datetime modifier for Postgres: '${mod}'`);
        return `to_char(((${expr})::timestamp ${interval}), 'YYYY-MM-DD HH24:MI:SS')`;
    });
    return sql;
}

/** Words that may legitimately appear in mixed case but are not identifiers. */
const MIXED_CASE_ALLOWLIST = new Set([]);

/** Quote mixed-case bare identifiers (outside strings). */
function quoteMixedCaseIdentifiers(code) {
    return code.replace(/(")?\b([A-Za-z_][A-Za-z0-9_]*)\b(")?/g, (whole, q1, word, q2) => {
        if (q1 || q2) return whole;                       // already quoted
        if (word === word.toLowerCase()) return whole;    // plain lowercase
        if (word === word.toUpperCase()) return whole;    // keyword-style
        if (MIXED_CASE_ALLOWLIST.has(word)) return whole;
        return `"${word}"`;
    });
}

/** COLLATE NOCASE forms that survive at query level. */
function rewriteNocase(code) {
    // X = $n COLLATE NOCASE  (also handles "..." quoted ids on either side)
    code = code.replace(/([\w@$."]+)\s*=\s*([\w@$."]+)\s+COLLATE\s+NOCASE/gi,
        (m, a, b) => `lower(${a}) = lower(${b})`);
    // ORDER BY X COLLATE NOCASE [ASC|DESC] (X may be a $n param)
    code = code.replace(/([\w$."]+)\s+COLLATE\s+NOCASE(\s+(?:ASC|DESC))?/gi,
        (m, expr, dir) => `lower(${expr})${dir || ''}`);
    return code;
}

/**
 * Translate one DML statement to Postgres.
 * @param {string} sql - SQLite-flavored SQL with @name params
 * @returns {{ text: string, paramNames: string[] }}
 */
/**
 * Scalar two-arg MIN()/MAX() -> LEAST()/GREATEST(). SQLite's MIN/MAX double
 * as scalar functions when given two arguments; Postgres separates them.
 * Aggregate single-argument calls are left alone (no top-level comma).
 */
function rewriteScalarMinMax(sql) {
    const re = /\b(MIN|MAX)\s*\(/gi;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(sql))) {
        const start = m.index;
        let depth = 1;
        let topComma = false;
        let i = re.lastIndex;
        let inString = false;
        for (; i < sql.length && depth > 0; i++) {
            const ch = sql[i];
            if (inString) { if (ch === "'") inString = false; continue; }
            if (ch === "'") inString = true;
            else if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === ',' && depth === 1) topComma = true;
        }
        if (topComma) {
            const fn = m[1].toUpperCase() === 'MIN' ? 'LEAST' : 'GREATEST';
            out += sql.slice(last, start) + fn + '(';
            last = re.lastIndex;
        }
    }
    return out + sql.slice(last);
}

/** Two-arg ROUND(expr, n): Postgres only rounds numerics to a precision. */
function rewriteTwoArgRound(sql) {
    const re = /\bROUND\s*\(/gi;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(sql))) {
        let depth = 1;
        let topComma = -1;
        let i = re.lastIndex;
        let inString = false;
        for (; i < sql.length && depth > 0; i++) {
            const ch = sql[i];
            if (inString) { if (ch === "'") inString = false; continue; }
            if (ch === "'") inString = true;
            else if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === ',' && depth === 1 && topComma === -1) topComma = i;
        }
        if (topComma !== -1) {
            const arg1 = sql.slice(re.lastIndex, topComma);
            out += sql.slice(last, m.index) + `ROUND((${arg1})::numeric,`;
            last = topComma + 1;
        }
    }
    return out + sql.slice(last);
}

/**
 * Postgres rejects unqualified self-references on the right side of
 * ON CONFLICT DO UPDATE SET (ambiguous with `excluded`); SQLite resolves
 * them to the target table. Qualify `col = col ...` self-references with
 * the insert target.
 */
function qualifyUpsertSelfRefs(sql) {
    const target = sql.match(/INSERT\s+INTO\s+("?[A-Za-z_][\w"]*)/i);
    if (!target) return sql;
    const table = target[1];
    return sql.replace(/(DO\s+UPDATE\s+SET\s)([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|$)/gi, (whole, head, body) =>
        head + body.replace(/("?[A-Za-z_][\w]*"?)(\s*=\s*)\1\b/g, (m2, col, eq) => `${col}${eq}${table}.${col}`));
}

function translateQuery(sql) {
    // SQLite blob literals (x'00ff') parse as bit strings in Postgres.
    sql = sql.replace(/\bx'([0-9A-Fa-f]*)'/g, (m, hex) => `decode('${hex}','hex')`);

    // @name -> $n FIRST (numbered by first appearance): the identifier-
    // quoting pass below must never see '@guildId' (it would quote the name
    // part and orphan the '@').
    const paramNames = [];
    let out = mapCode(sql, code => code.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => {
        let idx = paramNames.indexOf(name);
        if (idx === -1) { paramNames.push(name); idx = paramNames.length - 1; }
        return `$${idx + 1}`;
    }));

    out = rewriteScalarMinMax(out);
    out = rewriteTwoArgRound(out);
    out = qualifyUpsertSelfRefs(out);

    // A parameter whose ONLY appearance is `$n IS [NOT] NULL` gives Postgres
    // nothing to infer a type from; cast it (never compared, so text is
    // safe). Params that also appear in comparisons infer from those.
    out = mapCode(out, code => code.replace(/\$(\d+)(\s+IS\s+(?:NOT\s+)?NULL)/gi, (m, n, rest) => {
        const occurrences = (out.match(new RegExp(`\\$${n}(?!\\d)`, 'g')) || []).length;
        return occurrences === 1 ? `$${n}::text${rest}` : m;
    }));

    out = rewriteDatetimeFns(out);
    out = mapCode(out, code => {
        code = rewriteNocase(code);
        code = code.replace(/\bCURRENT_TIMESTAMP\b/g, PG_NOW_TEXT);
        code = code.replace(/\bLIKE\b/gi, m => (m === m.toLowerCase() ? 'ilike' : 'ILIKE'));
        code = quoteMixedCaseIdentifiers(code);
        return code;
    });

    return { text: out, paramNames };
}

/**
 * Translate one DDL statement (CREATE TABLE / CREATE INDEX / ALTER TABLE)
 * to Postgres.
 * @param {string} sql
 * @returns {string}
 */
function translateDdl(sql) {
    let out = sql;

    // Column types (identity first so the INTEGER pass doesn't eat it)
    out = out.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
        'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
    out = out.replace(/\bINTEGER\s+PRIMARY\s+KEY\b/gi,
        'BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
    out = mapCode(out, code => code
        .replace(/\bINTEGER\b/gi, 'BIGINT')
        .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
        .replace(/\bBLOB\b/gi, 'BYTEA'));

    // TEXT [NOT NULL] COLLATE NOCASE -> CITEXT (collation folds into type)
    out = out.replace(/\bTEXT\b([^,\n]*?)\s+COLLATE\s+NOCASE/gi, 'CITEXT$1');

    // Text-timestamp defaults
    out = mapCode(out, code =>
        code.replace(/\bDEFAULT\s+CURRENT_TIMESTAMP\b/gi, `DEFAULT ${PG_NOW_TEXT}`));
    out = out.replace(/\bDEFAULT\s+\(\s*datetime\(\s*'now'\s*\)\s*\)/gi, `DEFAULT ${PG_NOW_TEXT}`);
    out = out.replace(/\bDEFAULT\s+\(\s*date\(\s*'now'\s*\)\s*\)/gi, `DEFAULT ${PG_TODAY_TEXT}`);

    // SQLite (in)famously allows NULLs inside table-level PRIMARY KEYs, and
    // guild_activity leans on it (anonymized rows carry NULL userId, kept
    // distinct like any unique index). Postgres would force NOT NULL, so a
    // composite PK with any nullable member becomes a UNIQUE constraint -
    // identical NULLS DISTINCT semantics, and ON CONFLICT (cols) still
    // targets it.
    out = out.replace(/\bPRIMARY\s+KEY\s*\(([^)]+)\)/gi, (whole, cols, offset) => {
        const body = out;
        const nullable = cols.split(',').some(raw => {
            const col = raw.trim().replace(/"/g, '');
            const def = new RegExp(`^\\s*"?${col}"?\\s+[^,]*`, 'mi').exec(body);
            return def && !/NOT\s+NULL/i.test(def[0]) && !/PRIMARY\s+KEY/i.test(def[0]);
        });
        return nullable ? `UNIQUE (${cols})` : whole;
    });

    // Remaining datetime() defaults/checks and identifier casing
    out = rewriteDatetimeFns(out);
    out = mapCode(out, code => quoteMixedCaseIdentifiers(code));
    return out;
}

/**
 * Split a schema file into individual statements (semicolons outside
 * strings; comments stripped).
 */
function splitStatements(schemaSql) {
    const noComments = schemaSql.split('\n')
        .map(line => {
            // strip -- comments (naive but our schema keeps quotes off comment lines)
            const idx = line.indexOf('--');
            return idx === -1 ? line : line.slice(0, idx);
        })
        .join('\n');
    const statements = [];
    let cur = '';
    for (const seg of segmentSql(noComments)) {
        if (seg.isString) { cur += seg.text; continue; }
        let rest = seg.text;
        let splitAt;
        while ((splitAt = rest.indexOf(';')) !== -1) {
            cur += rest.slice(0, splitAt);
            if (cur.trim().length > 0) statements.push(cur.trim());
            cur = '';
            rest = rest.slice(splitAt + 1);
        }
        cur += rest;
    }
    if (cur.trim().length > 0) statements.push(cur.trim());
    return statements;
}

module.exports = {
    PG_NOW_TEXT,
    PG_TODAY_TEXT,
    translateQuery,
    translateDdl,
    splitStatements,
    segmentSql,
};
