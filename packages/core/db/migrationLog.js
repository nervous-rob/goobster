/** Successful upgrades are useful in production, but repeat for every Jest database. */
function logMigration(message) {
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) return;
    console.log(message);
}

module.exports = { logMigration };
