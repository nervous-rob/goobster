/**
 * Compatibility re-export. The Observatory *is* the Project: implementation
 * lives in projectService.js. Existing require('@goobster/core/services/observatoryService')
 * callers keep working; tables, routes, and the observatory tool are unchanged.
 */
module.exports = require('./projectService');
