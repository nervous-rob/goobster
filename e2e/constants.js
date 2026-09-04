/**
 * Shared identities and copy for the portal Playwright harness.
 * The server seeds these rows; the specs assert the React rooms render them.
 */
module.exports = {
    OWNER: '800000000000000001',
    OWNER_NAME: 'Rob',
    MEMBER: '800000000000000002',
    MEMBER_NAME: 'Frieda',
    BOT_ID: '900000000000000001',

    EXPEDITION_SEED: 'positive Grassmannian',
    EXPEDITION_INTENT: 'understand scattering amplitudes',
    EXPEDITION_SUMMARY: 'Mapped the parametrization.',
    CLAIM_TEXT: 'The positive Grassmannian parametrizes cells.',
    NOTE_LABEL: 'Positive Grassmannian',
    NOTE_CONTENT: 'It parametrizes cells.',
    SOURCE_TITLE: 'Total positivity',
    SOURCE_URL: 'https://arxiv.org/abs/1234.5678',

    PERSONA_NAME: 'Ada',
    PERSONA_CHARTER: 'A careful research companion.',
    PARLOR_USER_MESSAGE: 'Goobster, what is our ingest cadence?',
    PARLOR_REPLY: 'The ingest runs nightly.',
    PROJECT_KNOWLEDGE_LABEL: 'Ingest cadence',
    PROJECT_KNOWLEDGE_CONTENT: 'The ingest runs nightly.',

    PROJECT_NAME: 'Emergence study',
    MISSION_TITLE: 'pgvector at one million notes',
    MISSION_OBJECTIVE: 'Determine whether pgvector recall remains useful above one million notes.',
    MISSION_CRITERION_1: 'A reproducible benchmark artifact exists',
    MISSION_CRITERION_2: 'A written recommendation to keep, shard, or replace',
    MISSION_STEP: 'Write the recommendation',
    MISSION_REVIEW: 'Benchmark and recommendation are in the workspace.',
    ARTIFACT_PATH: 'out/result.json',
    ARTIFACT_IMAGE: 'out/frame.png',
    NOTICE_TITLE: 'Emergence study job failed',
    NOTICE_DETAIL: 'Job exited with code 3.',
    NOTICE_REASON: 'a failed Observatory job'
};
