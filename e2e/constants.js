/**
 * Shared identities and copy for the portal Playwright harness.
 * The server seeds these rows; the specs assert the React rooms render them.
 */
module.exports = {
    OWNER: '800000000000000001',
    OWNER_NAME: 'Rob',
    MEMBER: '800000000000000002',
    MEMBER_NAME: 'Frieda',
    NATIVE_MEMBER: 'usr_0f7f5d0e-3333-4a2b-9c3d-000000000003',
    NATIVE_MEMBER_NAME: 'Native colleague',
    BOT_ID: '900000000000000001',
    INBOX_TITLE: 'Unread research result',
    INBOX_BODY: 'Keep this result open while reading its detailed explanation.',
    INBOX_ATTACHMENT_TITLE: 'Attachment only result',
    INBOX_LEGACY_LINK_TITLE: 'Reminder written before the rename',

    EXPEDITION_SEED: 'positive Grassmannian',
    EXPEDITION_INTENT: 'understand scattering amplitudes',
    EXPEDITION_SUMMARY: 'Mapped the parametrization.',
    CLAIM_TEXT: 'The positive Grassmannian parametrizes cells.',
    NOTE_LABEL: 'Positive Grassmannian',
    NOTE_CONTENT: 'It parametrizes cells.',
    SOURCE_TITLE: 'Total positivity',
    SOURCE_URL: 'https://arxiv.org/abs/1234.5678',

    // Saved-knowledge curation fixtures (ADR 0008): one note Goobster
    // distilled (memory), one legacy row a tool wrote without saying why
    // (unclassified), one distilled fact, one raw memory.
    DISTILLED_NOTE_LABEL: 'Prefers morning deep work',
    DISTILLED_NOTE_CONTENT: 'Distilled from several chats: deep work happens before noon.',
    LEGACY_NOTE_LABEL: 'Old tool scribble',
    LEGACY_NOTE_CONTENT: 'Written by a tool before notes were sorted.',
    FACT_CONTENT: 'Rob keeps a raspberry pi on the shelf',
    MEMORY_CONTENT: 'Rob mentioned the ingest job runs on the pi at night.',

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
