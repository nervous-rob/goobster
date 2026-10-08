const { prepareConnection } = require('@goobster/core/services/postgresToolConnection');

describe('PostgreSQL backup tool credentials', () => {
    test('moves encoded passwords into the child environment without mutating its caller', () => {
        const args = ['--format=custom', '--dbname', 'postgresql://owner:p%40ss%3A%2F%25@localhost:5433/goobster?sslmode=require'];
        const env = { PATH: '/bin', PGPASSWORD: 'old' };
        const child = prepareConnection(args, env);
        expect(child.args).toEqual(['--format=custom', '--dbname', 'postgresql://owner@localhost:5433/goobster?sslmode=require']);
        expect(child.env.PGPASSWORD).toBe('p@ss:/%');
        expect(env.PGPASSWORD).toBe('old');
        expect(args[2]).toContain('p%40ss');
    });

    test('removes query passwords too and preserves libpq query precedence', () => {
        const child = prepareConnection(['--dbname', 'postgres://owner:hidden@localhost/db?password=first&sslmode=require&password=last%3Asecret'], {});
        expect(child.args[1]).toBe('postgres://owner@localhost/db?sslmode=require');
        expect(child.env.PGPASSWORD).toBe('last:secret');
    });

    test('preserves passwordless authentication and a caller-supplied credential environment', () => {
        const env = { PGPASSFILE: '/private/pgpass' };
        expect(prepareConnection(['--dbname', 'postgres://owner@localhost/db'], env)).toEqual({ args: ['--dbname', 'postgres://owner@localhost/db'], env });
    });
});
