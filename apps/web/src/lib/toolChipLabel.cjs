/**
 * Visible labels for portal tool chips. Observatory calls all share the
 * tool name "observatory", so the chip header used to be "Working:
 * observatory" with the action/project/path only in a hover title — useless
 * on a phone. This helper puts that basic context in the chip itself.
 * CommonJS so Jest can require() it; Vite interops the same file.
 */

const TOOL_LABELS = {
    performSearch: ['Searching the web', 'Searched the web'],
    generateImage: ['Generating an image', 'Generated an image'],
    runCode: ['Running code', 'Ran code'],
    searchGithubCode: ['Searching GitHub', 'Searched GitHub'],
    readGithubFile: ['Reading a GitHub file', 'Read a GitHub file'],
    searchNotion: ['Searching Notion', 'Searched Notion'],
    readNotionPage: ['Reading a Notion page', 'Read a Notion page'],
    rememberFact: ['Saving a memory', 'Saved a memory'],
    forgetFact: ['Removing a memory', 'Removed a memory'],
    scheduleFollowUp: ['Scheduling a follow-up', 'Scheduled a follow-up'],
    manageAutomations: ['Managing your automations', 'Managed your automations'],
    manageParlor: ['Working in your Parlor', 'Worked in your Parlor'],
    stockQuote: ['Checking stock prices', 'Checked stock prices'],
    rollDice: ['Rolling dice', 'Rolled dice']
};

const OBS_VERBS = {
    inspect: ['Inspecting', 'Inspected'],
    audit: ['Auditing', 'Audited'],
    'needs-you': ['Checking what needs you', 'Checked what needs you'],
    'create-project': ['Creating project', 'Created project'],
    list: ['Listing projects', 'Listed projects'],
    run: ['Running', 'Ran'],
    status: ['Checking job', 'Checked job'],
    resume: ['Resuming job', 'Resumed job'],
    cancel: ['Cancelling job', 'Cancelled job'],
    files: ['Listing files', 'Listed files'],
    read: ['Reading', 'Read'],
    render: ['Rendering', 'Rendered'],
    dashboard: ['Building dashboard', 'Built dashboard'],
    'fetch-data': ['Fetching data', 'Fetched data'],
    'delete-project': ['Deleting project', 'Deleted project'],
    save_app: ['Saving app', 'Saved app'],
    save_script: ['Saving script', 'Saved script'],
    save_note: ['Saving note', 'Saved note'],
    list_assets: ['Listing assets', 'Listed assets'],
    get_asset: ['Reading asset', 'Read asset'],
    rollback_asset: ['Rolling back', 'Rolled back'],
    run_script: ['Running script', 'Ran script'],
    set_trigger: ['Setting trigger', 'Set trigger'],
    list_triggers: ['Listing triggers', 'Listed triggers'],
    delete_trigger: ['Deleting trigger', 'Deleted trigger'],
    invite_user: ['Inviting collaborator', 'Invited collaborator'],
    list_members: ['Listing members', 'Listed members'],
    remove_member: ['Removing member', 'Removed member'],
    note_knowledge: ['Noting', 'Noted'],
    recall_knowledge: ['Recalling', 'Recalled'],
    mission: ['Updating mission', 'Updated mission']
};

const MISSION_VERBS = {
    propose: ['Proposing mission', 'Proposed mission'],
    get: ['Reading mission', 'Read mission'],
    update: ['Updating mission', 'Updated mission'],
    add_step: ['Adding mission step', 'Added mission step'],
    start_step: ['Starting mission step', 'Started mission step'],
    complete_step: ['Completing mission step', 'Completed mission step'],
    skip_step: ['Skipping mission step', 'Skipped mission step'],
    add_evidence: ['Adding mission evidence', 'Added mission evidence'],
    review: ['Reviewing mission', 'Reviewed mission'],
    cancel: ['Cancelling mission', 'Cancelled mission'],
    resume: ['Resuming mission', 'Resumed mission']
};

function toolLabel(name, done) {
    const entry = TOOL_LABELS[name];
    if (entry) return entry[done ? 1 : 0];
    const words = String(name || '').replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    if (!words) return done ? 'Finished' : 'Working';
    return done ? `Finished: ${words}` : `Working: ${words}`;
}

function clip(text, max) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function fileName(value) {
    const raw = String(value || '').replace(/\\/g, '/').trim();
    if (!raw) return '';
    const parts = raw.split('/').filter(Boolean);
    return parts[parts.length - 1] || raw;
}

function salvageField(preview, key) {
    const source = String(preview || '');
    const stringMatch = source.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (stringMatch) {
        return stringMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    const numberMatch = source.match(new RegExp(`"${key}"\\s*:\\s*(-?\\d+)`));
    if (numberMatch) return Number(numberMatch[1]);
    const boolMatch = source.match(new RegExp(`"${key}"\\s*:\\s*(true|false)`));
    if (boolMatch) return boolMatch[1] === 'true';
    return undefined;
}

function parseArgsPreview(preview) {
    if (!preview || preview === '{}') return null;
    const raw = String(preview);
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { /* truncated chip previews are common */ }
    try {
        const parsed = JSON.parse(raw.replace(/…$/, ''));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch { /* salvage individual fields below */ }

    const keys = [
        'action', 'project', 'path', 'name', 'slug', 'language', 'jobId',
        'url', 'saveAs', 'query', 'label', 'missionAction', 'background',
        'stepTitle'
    ];
    const salvaged = {};
    for (const key of keys) {
        const value = salvageField(raw, key);
        if (value !== undefined) salvaged[key] = value;
    }
    return Object.keys(salvaged).length > 0 ? salvaged : null;
}

function observatoryVerb(args, done) {
    const action = args && args.action;
    if (action === 'mission') {
        const mission = MISSION_VERBS[args.missionAction];
        if (mission) return mission[done ? 1 : 0];
    }
    const entry = OBS_VERBS[action];
    if (entry) return entry[done ? 1 : 0];
    return done ? 'Finished: observatory' : 'Working: observatory';
}

function observatoryContext(args) {
    if (!args) return '';
    const bits = [];
    const action = args.action;
    const project = clip(args.project, 40);
    const named = clip(args.slug || args.name, 40);
    const pathName = fileName(args.path || args.saveAs);

    if (action === 'run' && args.language) bits.push(String(args.language));
    if (action === 'run' && args.background) bits.push('background');
    if (pathName && (action === 'read' || action === 'fetch-data')) bits.push(pathName);
    if (named && (
        action === 'create-project'
        || action === 'save_app'
        || action === 'save_script'
        || action === 'save_note'
        || action === 'get_asset'
        || action === 'rollback_asset'
        || action === 'run_script'
        || action === 'set_trigger'
        || action === 'delete_trigger'
    )) bits.push(named);
    if (args.jobId != null && args.jobId !== '') bits.push(`#${args.jobId}`);
    if (action === 'fetch-data' && !pathName && args.url) bits.push(clip(args.url, 36));
    if (action === 'recall_knowledge' && args.query) bits.push(clip(args.query, 40));
    if (action === 'note_knowledge' && args.label) bits.push(clip(args.label, 40));
    if (action === 'mission' && args.stepTitle) bits.push(clip(args.stepTitle, 40));
    if (project && action !== 'create-project') bits.push(project);
    return bits.filter(Boolean).join(' · ');
}

/**
 * @param {string} name
 * @param {string} [argsPreview]
 * @param {{ done?: boolean }} [opts]
 * @returns {{ verb: string, context: string, header: string }}
 */
function describeToolChip(name, argsPreview, { done = false } = {}) {
    if (name === 'observatory') {
        const args = parseArgsPreview(argsPreview);
        const verb = observatoryVerb(args, done);
        const context = observatoryContext(args);
        return {
            verb,
            context,
            header: context ? `${verb} · ${context}` : verb
        };
    }
    const verb = toolLabel(name, done);
    return { verb, context: '', header: verb };
}

function chipHoverTitle(argsPreview, resultPreview) {
    const parts = [];
    if (argsPreview && argsPreview !== '{}') parts.push(argsPreview);
    if (resultPreview) parts.push(`→ ${resultPreview}`);
    return parts.length > 0 ? parts.join('\n') : undefined;
}

module.exports = {
    TOOL_LABELS,
    toolLabel,
    parseArgsPreview,
    describeToolChip,
    chipHoverTitle
};
