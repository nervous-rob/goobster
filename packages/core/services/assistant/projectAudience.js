/**
 * Findings for a project's members (DA-11c, ADR 0018 "What is deliberately
 * not here", ARCH 13.5 "Project audiences").
 *
 * A finding goes to the project's members instead of only to the person who
 * delegated the work when every one of these holds *when it is published*:
 *
 *  - the grant asks for it (`scopes.audience: 'project'`, with a linked
 *    project) and the work was proposed under that grant;
 *  - the pilot gate lets this person use the `reach` capability
 *    (assistantAccessService; the owner only until the host records the
 *    pilot decision);
 *  - the person still reads the project (owner or accepted collaborator);
 *  - what prompted the work belongs to the project: its plan, or a request
 *    made in the project's own conversation. The person's own Attention
 *    goal, or a discussion outside the project, is private and stays so;
 *  - the run read none of the person's private knowledge.
 *
 * Anything else publishes the finding to the person alone, as before, and
 * the notice says in words why it was not shared.
 *
 * A run that is going to share is not offered the tools that read the
 * person's private knowledge at all (`startsShared`), so a shared finding
 * cannot quote them; `decide` checks again at publication in case that
 * changed meanwhile (a resumed run, a closed pilot, a lost membership).
 *
 * Spec: documentation/delegated_project_findings.md.
 */

const db = require('../../db');

/** The pilot capability this belongs to (assistantAccessService.CAPABILITIES). */
const CAPABILITY = 'reach';
/** Source kinds that are the project's own whatever the conversation. */
const OWN_SOURCE_KINDS = new Set(['project_plan', 'project_plan_step']);

/** Why a finding was not shared, in words the person reads (codes only are stored). */
const REASONS = Object.freeze({
    PILOT_ONLY: 'Sharing findings with a project is limited to the host until the pilot decision is recorded.',
    PRIVATE_CONTEXT: 'It used your private notes, which are never quoted into a project.',
    SOURCE_PRIVATE: 'What prompted it is private to you (your own goal, or a discussion outside this project).',
    NOT_MEMBER: 'You no longer have access to that project.',
    NO_PROJECT: 'The project is no longer linked or available.',
    SHARE_FAILED: 'Sharing it with the project did not work.'
});

function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw) || fallback; } catch { return fallback; }
}

/** Does this grant ask for its findings to go to the project? */
function requested(responsibility, initiative) {
    if (!responsibility?.projectId || initiative?.audience !== 'project') return false;
    return parseJson(responsibility.scopesJson, {}).audience === 'project';
}

/** Is what prompted this work the project's own? */
function ownSource(initiative, projectId) {
    const kind = initiative?.source?.kind;
    if (OWN_SOURCE_KINDS.has(kind)) return true;
    if (kind !== 'conversation_request') return false;
    const origin = initiative.origin;
    return origin?.surface === 'project' && Number(origin.audience?.projectId) === Number(projectId);
}

async function reads(userId, projectId) {
    const row = await db.get(
        `SELECT 1 AS ok FROM observatory_projects p
         WHERE p.id = @projectId
           AND (p.userId = @userId
                OR EXISTS (SELECT 1 FROM project_members m WHERE m.projectId = p.id AND m.userId = @userId))`,
        { projectId: Number(projectId), userId: String(userId) }
    );
    return Boolean(row);
}

/**
 * Where does this work's finding go, as things stand now?
 * @param {Object} params
 * @param {Object} params.initiative - presented (audience, source, origin)
 * @param {Object} params.responsibility - the stored row
 * @param {{ id: number }|null} params.project - the linked project, when it still exists
 * @param {boolean} [params.privateRead] - the run read the person's private knowledge
 * @returns {Promise<{ requested: boolean, shared: boolean, code?: string }>}
 */
async function decide({ initiative, responsibility, project, privateRead = false }) {
    if (!requested(responsibility, initiative)) return { requested: false, shared: false };
    if (!project || Number(project.id) !== Number(responsibility.projectId)) {
        return { requested: true, shared: false, code: 'NO_PROJECT' };
    }
    const owner = responsibility.ownerUserId;
    if (!(await require('../assistantAccessService').allows(owner, CAPABILITY))) {
        return { requested: true, shared: false, code: 'PILOT_ONLY' };
    }
    if (!(await reads(owner, project.id))) return { requested: true, shared: false, code: 'NOT_MEMBER' };
    if (!ownSource(initiative, project.id)) return { requested: true, shared: false, code: 'SOURCE_PRIVATE' };
    if (privateRead) return { requested: true, shared: false, code: 'PRIVATE_CONTEXT' };
    return { requested: true, shared: true };
}

/** What a run is told when its report goes to the project's members. */
const SHARED_PROMPT = (project) => `Your report will be shared with every member of the project${project ? ` "${project.name}"` : ''}, not only the person who delegated this. Write it for all of them: what was found and where it came from. Do not decide anything on the project's behalf.`;

/** The sentence a notice carries when a requested share did not happen. */
function keptPrivate(code) {
    return `Kept private: ${REASONS[code] || REASONS.SHARE_FAILED}`;
}

module.exports = { CAPABILITY, REASONS, SHARED_PROMPT, OWN_SOURCE_KINDS, requested, ownSource, decide, keptPrivate };
