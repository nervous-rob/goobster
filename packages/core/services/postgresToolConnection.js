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
    // libpq URI parameters use percent encoding, not form encoding: '+' would
    // turn the native connection's '-c search_path=public' into an invalid option.
    url.search = [...url.searchParams].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    safeArgs[index + 1] = url.toString();
    return { args: safeArgs, env: password === null ? env : { ...env, PGPASSWORD: password } };
}

module.exports = { prepareConnection };
