/**
 * Ready-made project apps (services/appTemplates.js): every template
 * renders to a complete document whose scripts parse, declares only the
 * project access it uses, carries its settings in a config block no value
 * can break out of, and refuses unknown templates and unsafe paths.
 */
const vm = require('node:vm');
const { listTemplates, renderTemplate, TEMPLATE_IDS } = require('@goobster/core/services/appTemplates');

function configOf(source) {
    const match = source.match(/<script id="goobster-app-config" type="application\/json">([\s\S]*?)<\/script>/);
    return match ? JSON.parse(match[1]) : null;
}

function declaredAccess(source) {
    const match = source.match(/<meta name="goobster-project-access" content="([^"]*)">/);
    return match ? match[1].split(/\s+/).filter(Boolean) : [];
}

describe('app templates', () => {
    test('the catalog lists every template with its access and parameters, no HTML', () => {
        const catalog = listTemplates();
        expect(catalog.map(t => t.id)).toEqual(TEMPLATE_IDS);
        for (const entry of catalog) {
            expect(entry).not.toHaveProperty('html');
            expect(entry.params.some(p => p.key === 'path' && p.required)).toBe(true);
        }
        expect(catalog.find(t => t.id === 'chart').access).toEqual([]);
    });

    test.each(TEMPLATE_IDS)('%s renders a document whose scripts parse and whose declaration matches its access', (id) => {
        const { source, config } = renderTemplate(id, { title: 'Lab tool', path: 'data/x.csv', args: '--days 3' });
        expect(source.startsWith('<!doctype html>')).toBe(true);
        expect(source).not.toMatch(/__TITLE__|__CONFIG__/);
        expect(configOf(source)).toEqual(config);
        const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        expect(scripts.length).toBe(1);
        for (const code of scripts) expect(() => new vm.Script(code)).not.toThrow();
        // App frames have no allow-forms: a <form> submit would be blocked.
        expect(source).not.toMatch(/<form[\s>]/);
        const expected = listTemplates().find(t => t.id === id).access;
        expect(declaredAccess(source)).toEqual(expected);
    });

    test('a title or path cannot break out of the title or the config block', () => {
        const { source, config } = renderTemplate('data-table', {
            title: 'x</title><script>alert(1)</script>', path: 'data/</script><b>.json'
        });
        expect(source).toContain('<title>x&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
        expect(configOf(source)).toEqual(config);
        expect(config.path).toBe('data/</script><b>.json');
        expect(source.match(/<\/script>/g)).toHaveLength(2);
    });

    test('defaults fill missing parameters; run-console keeps its arguments', () => {
        expect(renderTemplate('chart').config).toEqual({ title: 'Chart', path: 'data/metrics.csv' });
        expect(renderTemplate('run-console', { path: 'sim/run.py', args: '--days 30' }).config)
            .toEqual({ title: 'Run console', path: 'sim/run.py', args: '--days 30' });
    });

    test('refuses an unknown template and a path that leaves the workspace', () => {
        expect(() => renderTemplate('nope')).toThrow(expect.objectContaining({ code: 'NO_SUCH_TEMPLATE', status: 400 }));
        for (const path of ['../secret.json', 'a//b.json', 'data/../../x']) {
            expect(() => renderTemplate('chart', { path })).toThrow(expect.objectContaining({ code: 'BAD_PATH' }));
        }
        expect(renderTemplate('chart', { path: '/data/x.csv' }).config.path).toBe('data/x.csv');
    });
});
