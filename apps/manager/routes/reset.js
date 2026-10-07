/**
 * The reset preview (documentation/data_reset.md), under /manager/api:
 *
 *   GET /reset/plan?scope=instance
 *   GET /reset/plan?scope=feature&feature=<id>
 *
 * The same scope preview the CLI's `reset --dry-run` prints: the tables a
 * reset would empty (and the shared-table rows a feature purge removes), the
 * file sets, what is kept or recreated, what is never touched, and the text
 * to type to confirm. It reads the manager store and the file system only:
 * no database is opened and nothing is written. Running a reset is the
 * `data.reset` operation kind, through the operations API.
 */

const { ManagerError } = require('../errors');
const { previewReset } = require('../engine/kinds/reset');

const QUERY_KEYS = new Set(['scope', 'feature']);

function mountResetRoutes(api, { route, readAuth, manager }) {
    api.get('/reset/plan', route((req) => {
        readAuth(req);
        for (const key of Object.keys(req.query || {})) {
            if (!QUERY_KEYS.has(key)) throw new ManagerError(400, 'INVALID_INPUT', 'The query has a parameter the reset preview does not accept.');
        }
        const { scope, feature } = req.query || {};
        if (typeof scope !== 'string' || (feature !== undefined && typeof feature !== 'string')) {
            throw new ManagerError(400, 'INVALID_INPUT', '"scope" must be "instance" or "feature" (with "feature").');
        }
        return previewReset({ settings: manager.settings, scope: { scope, ...(feature !== undefined ? { feature } : {}) } });
    }));
}

module.exports = { mountResetRoutes };
