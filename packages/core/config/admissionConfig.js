let file = {};
try { file = require('../../../config.json').admission || {}; } catch { /* optional */ }
const bounded = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) > 0
    ? Math.min(max, Math.floor(Number(value))) : fallback;
module.exports = {
    modelConcurrent: bounded(file.modelConcurrent, 4, 400),
    modelPerAccount: bounded(file.modelPerAccount, 1, 40),
    modelQueueMs: bounded(file.modelQueueMs, 30000, 300000),
    modelTimeoutMs: bounded(file.modelTimeoutMs, 300000, 1200000),
    streamConcurrent: bounded(file.streamConcurrent, 128, 10000),
    streamPerAccount: bounded(file.streamPerAccount, 12, 200),
    streamPerSession: bounded(file.streamPerSession, 6, 100)
};
