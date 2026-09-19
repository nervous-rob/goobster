/** Continuous Study history expiry. Access paths also purge before serving. */
const db = require('../db');
const logger = require('../utils/logger');
let timer = null;
let pending = null;
async function sweep() {
    if (pending) return pending;
    pending = db.withSingletonLock('study_history_retention', async () => {
        const rows = await db.all('SELECT userId FROM user_settings');
        let purged = 0;
        for (const row of rows) {
            purged += await require('./webChatService').purgeExpiredConversations(row.userId);
        }
        return purged;
    }).finally(() => { pending = null; });
    return pending;
}
function start() {
    if (timer) return;
    const tick = () => sweep().catch(error => logger.warn(`[history retention] ${error.message}`));
    timer = setInterval(tick, 60 * 60 * 1000);
    timer.unref?.();
    void tick();
}
async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await pending;
}
module.exports = { start, stop, sweep };
