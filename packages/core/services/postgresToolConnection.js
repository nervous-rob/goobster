'use strict';

/** Keep libpq passwords out of pg_dump/pg_restore argv and child error.cmd. */
function prepareConnection(args, env = process.env) {
    const safeArgs = [...args];
    const index = safeArgs.indexOf('--dbname');
    if (index < 0 || !/^postgres(?:ql)?:\/\//i.test(safeArgs[index + 1] || '')) return { args: safeArgs, env };
    const url = new URL(safeArgs[index + 1]);
    const queryPasswords = url.searchParams.getAll('password');
    const password = queryPasswords.length ? queryPasswords.at(-1) : url.password ? decodeURIComponent(url.password) : null;
    url.password = '';
    url.searchParams.delete('password');
    safeArgs[index + 1] = url.toString();
    return { args: safeArgs, env: password === null ? env : { ...env, PGPASSWORD: password } };
}

module.exports = { prepareConnection };
