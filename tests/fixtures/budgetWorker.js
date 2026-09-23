const db = require('@goobster/core/db');
const budgets = require('@goobster/core/services/usageBudgetService');
process.on('message', async options => {
    try { process.send({ id: await budgets.reserve(options) }); }
    catch (error) { process.send({ error: error.code || error.message }); }
});
db.get('SELECT COUNT(*) AS n FROM usage_reservations').then(() => process.send({ ready: true }));
