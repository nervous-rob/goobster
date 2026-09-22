const db = require('@goobster/core/db');
const admission = require('@goobster/core/services/resourceAdmissionService');
let lease;
process.on('message', async message => {
    try {
        if (message.action === 'claim') {
            lease = await admission.acquire(message.options);
            process.send({ claimed: lease.id });
        } else if (message.action === 'release') {
            await lease?.release();
            process.send({ released: true });
        }
    } catch (error) { process.send({ error: error.code || error.message }); }
});
db.get('SELECT COUNT(*) AS n FROM execution_admissions').then(() => process.send({ ready: true }));
