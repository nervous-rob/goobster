#!/usr/bin/env node
/**
 * Application identity: migration report, principal backfill, operator bootstrap.
 *
 *   npm run identity:report                        # read-only report (no writes)
 *   npm run identity:report -- --json              # the same, machine-readable
 *   npm run identity:report -- --backfill          # create principals for every legacy owner
 *   npm run identity:report -- --bootstrap-operators [id ...]
 *                                                  # grant the operator role to identity.operators
 *                                                  # (config.json / GOOBSTER_IDENTITY_OPERATORS) or
 *                                                  # the ids given on the command line
 *
 * The report walks every identity-bearing table (identityService.OWNER_COLUMNS),
 * counts distinct owners, and says how many already have a principal or an
 * account and which ids cannot be resolved. --backfill is idempotent: run it
 * twice and the second run creates nothing. Neither step grants portal
 * accounts to historical bot users - only --bootstrap-operators writes an
 * app_accounts row, and only for the ids you name.
 *
 * Spec: documentation/shared_instance_product_spec.md (section 5).
 */
'use strict';

const identityService = require('@goobster/core/services/identityService');

function printReport(report) {
    console.log(`Identity report - installation "${report.installationId}", generated ${report.generatedAt} UTC`);
    console.log(`Release gate requireAccount: ${report.requireAccount ? 'ON' : 'off'}`);
    console.log('');
    console.log('Owners across identity-bearing tables:');
    const o = report.owners;
    console.log(`  distinct owners: ${o.total} (${o.snowflake} Discord-shaped, ${o.native} native, ${o.unresolved} unresolved)`);
    console.log(`  with a principal: ${o.withPrincipal}   with an account: ${o.withAccount}`);
    console.log(`Principals: ${report.principals.total}   Accounts: ${report.accounts.total} `
        + `(${report.accounts.active} active, ${report.accounts.disabled} disabled, ${report.accounts.operators} operators)`);
    console.log('');
    console.log('Per table:');
    for (const t of report.tables) {
        const suffix = t.error ? `  [skipped: ${t.error}]` : '';
        console.log(`  ${`${t.table}.${t.column}`.padEnd(40)} rows ${String(t.rows).padStart(7)}  owners ${String(t.owners).padStart(5)}${suffix}`);
    }
    if (report.unresolved.length) {
        console.log('');
        console.log('Unresolved owner ids (not Discord-shaped, not native):');
        for (const u of report.unresolved) {
            console.log(`  ${u.id}  rows ${u.rows}  in ${u.tables.join(', ')}`);
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    const flags = new Set(args.filter(a => a.startsWith('--')));
    const positional = args.filter(a => !a.startsWith('--'));
    const db = require('@goobster/core/db');
    try {
        if (flags.has('--backfill')) {
            const outcome = await identityService.backfillPrincipals();
            console.log(`Backfill: scanned ${outcome.scanned} owner(s); created ${outcome.created}, `
                + `already present ${outcome.existing}, skipped ${outcome.skipped} (not Discord-shaped).`);
        }
        if (flags.has('--bootstrap-operators')) {
            const ids = positional.length ? positional : undefined;
            const outcome = await identityService.bootstrapOperators(ids);
            console.log(`Operators: granted ${outcome.granted.length}, promoted ${outcome.promoted.length}, `
                + `unchanged ${outcome.unchanged.length}, rejected ${outcome.rejected.length}`
                + `${outcome.rejected.length ? ` (${outcome.rejected.join(', ')})` : ''}.`);
            if (!outcome.granted.length && !outcome.promoted.length && !outcome.unchanged.length) {
                console.log('No operator ids given. Set identity.operators in config.json, '
                    + 'GOOBSTER_IDENTITY_OPERATORS, or pass ids on the command line.');
            }
        }
        const report = await identityService.migrationReport();
        if (flags.has('--json')) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            if (flags.has('--backfill') || flags.has('--bootstrap-operators')) console.log('');
            printReport(report);
        }
    } finally {
        await db.closeConnection();
    }
}

main().catch((error) => {
    console.error('Identity report failed:', error);
    process.exitCode = 1;
});
