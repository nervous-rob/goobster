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

    // Research brief (#254): what the fake model writes from the seeded
    // expedition's evidence, and the owner's wording edit in the journey.
    BRIEF_SUMMARY: 'The positive Grassmannian parametrizes cells, on one preprint.',
    BRIEF_FINDING: 'The positive Grassmannian parametrizes cells.',
    BRIEF_LIMITATION: 'A single source carries every finding.',
    BRIEF_EDITED_SUMMARY: 'One preprint says the positive Grassmannian parametrizes cells.',

    // Saved-knowledge curation fixtures (ADR 0008): one note Goobster
    // distilled (memory), one legacy row a tool wrote without saying why
    // (unclassified), one distilled fact, one raw memory.
    DISTILLED_NOTE_LABEL: 'Prefers morning deep work',
    DISTILLED_NOTE_CONTENT: 'Distilled from several chats: deep work happens before noon.',
    LEGACY_NOTE_LABEL: 'Old tool scribble',
    LEGACY_NOTE_CONTENT: 'Written by a tool before notes were sorted.',
    FACT_CONTENT: 'Rob keeps a raspberry pi on the shelf',
    MEMORY_CONTENT: 'Rob mentioned the ingest job runs on the pi at night.',

    // A saved chat with one answer worth keeping (ADR 0010: answer -> note ->
    // project) and one generated app (the Save to project… hop).
    CHAT_TITLE: 'Compound interest',
    CHAT_QUESTION: 'Explain compound interest, with the formula.',
    CHAT_ANSWER_HEADING: 'Compound interest formula',
    CHAT_ANSWER_BODY: 'The balance after t years is A = P(1 + r/n)^(nt).',
    CHAT_APP_TITLE: 'Interest dial',
    // Minted by POST /e2e/fixtures/distilled-note: a memory row the picker must refuse.
    TRANSFER_MEMORY_LABEL: 'Checks rates on Fridays',
    TRANSFER_MEMORY_CONTENT: 'Distilled: the rate questions always come on a Friday.',

    PERSONA_NAME: 'Ada',
    PERSONA_CHARTER: 'A careful research companion.',
    PARLOR_USER_MESSAGE: 'Goobster, what is our ingest cadence?',
    PARLOR_REPLY: 'The ingest runs nightly.',
    PROJECT_KNOWLEDGE_LABEL: 'Ingest cadence',
    PROJECT_KNOWLEDGE_CONTENT: 'The ingest runs nightly.',

    PROJECT_NAME: 'Emergence study',
    PROJECT_SLUG: 'emergence-study',
    PROJECT_GOAL: 'Find out whether the nightly ingest cadence changes what emerges.',
    // Frieda owns a project with the SAME name (and slug) and has Rob on it,
    // so Rob's list carries two "Emergence study" rows that differ by owner.
    TWIN_PROJECT_GOAL: 'A different study that happens to share the name.',
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
    NOTICE_REASON: 'a failed Observatory job',

    // One _contact delivery of three notices (package E5). Scores stay
    // below NOTICE_TITLE so journeys.spec.js still acts on that notice first.
    CONTACT_LEAD: 'The ingest watch fired',
    CONTACT_MORE_1: 'A second watch fired',
    CONTACT_MORE_2: 'A third watch fired',
    CONTACT_BODY: 'The nightly ingest changed while you were away.',
    CONTACT_INBOX_TITLE: 'The ingest watch fired (+2 more)',

    // Tutorial framework (F1): a note that Reset all must leave alone.
    TUTORIAL_SIDE_NOTE: 'Tutorial side-effect note'
};
