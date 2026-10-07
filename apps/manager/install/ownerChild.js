/**
 * Child process of `owner.create` and of the first-run check: read one JSON
 * request on stdin, act on the application database the environment selects
 * (GOOBSTER_DB_PATH or GOOBSTER_DB_URL, exactly as for the application),
 * print one JSON line, exit. The password arrives on stdin only - never in
 * argv or the environment - and nothing secret is printed.
 *
 *   { mode: 'create', loginName, password, displayName? }
 *       creates the first operator through the existing native sign-in path
 *       (an operator invitation, then registration). Refuses when an account
 *       already exists.
 *   { mode: 'check' }
 *       { ok: true, accounts: <count of accounts>, operators: <count of operators> }
 */

function readStdin() {
    return new Promise((resolve, reject) => {
        const chunks = [];
        process.stdin.on('data', chunk => chunks.push(chunk));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}

function codeOf(error) {
    return String((error && error.code) || (error && error.name) || 'ERROR').slice(0, 60);
}

(async () => {
    const db = require('@goobster/core/db');
    try {
        const request = JSON.parse(await readStdin());
        const counts = await db.get(
            `SELECT COUNT(*) AS accounts, SUM(CASE WHEN role = 'operator' THEN 1 ELSE 0 END) AS operators FROM app_accounts`
        );
        const accounts = Number((counts && counts.accounts) || 0);
        const operators = Number((counts && counts.operators) || 0);
        if (request.mode === 'check') {
            process.stdout.write(`${JSON.stringify({ ok: true, accounts, operators })}\n`);
        } else if (request.mode === 'create') {
            if (accounts > 0) {
                process.stdout.write(`${JSON.stringify({ ok: false, code: 'ACCOUNT_EXISTS' })}\n`);
                process.exitCode = 1;
            } else {
                const nativeAuth = require('@goobster/core/services/nativeAuthService');
                const { token } = await nativeAuth.createInvite({ issuedBy: 'manager-setup', role: 'operator', ttlHours: 1, note: 'first operator' });
                const account = await nativeAuth.register({
                    token,
                    loginName: request.loginName,
                    password: request.password,
                    displayName: request.displayName || null
                });
                process.stdout.write(`${JSON.stringify({ ok: true, loginName: account.loginName, role: account.role })}\n`);
            }
        } else {
            process.stdout.write(`${JSON.stringify({ ok: false, code: 'BAD_MODE' })}\n`);
            process.exitCode = 1;
        }
    } catch (error) {
        process.stdout.write(`${JSON.stringify({ ok: false, code: codeOf(error) })}\n`);
        process.exitCode = 1;
    }
    try { await db.closeConnection(); } catch { }
})();
