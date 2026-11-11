/**
 * Shared tool prompt building for all AI providers.
 *
 * Two flavors:
 * - buildNativeToolGuidance(): concise usage guidance injected as a system
 *   message for providers with native function calling (OpenAI, Gemini).
 * - buildPromptBasedToolPrompt() + parseToolCall(): a JSON protocol for
 *   providers without native tool support (Ollama).
 */

function formatToolDocs(functions) {
    return functions.map(fn => {
        const { name, description, parameters } = fn;
        // Include enums, required fields and nested shapes for prompt-based providers too.
        return `**${name}**: ${description || 'No description available'}\nParameters (JSON Schema):\n${JSON.stringify(parameters || { type: 'object', properties: {} })}`;
    }).join('\n\n');
}

const NOTES_GUIDANCE = `**PERSONAL / SERVER NOTES:**
The prompt only includes a small relevant slice. If you need a detail about this person or this server that is not there, call lookupNotes (about="me" or about="server") instead of guessing. Remember new durable facts with rememberFact. When they share a file worth keeping (code, docs, PDFs), save it with saveArtifact — ask first if unsure, then confirm=true. lookupNotes can recall saved artifact contents later.

**PICTURES AND FILES FROM THE WEB:**
- "What does X look like?" / "show me a Y" → call findImages with the full formal name; it searches the web, saves the pictures into their knowledge base with your notes, and displays them in the chat. Then describe what is shown and credit the source briefly — never paste image URLs.
- A specific file URL (an image, CSV, JSON, Markdown, text, code, or PDF) → call fetchWebFile; it saves the file and displays it (CSV renders as a table, text as a preview). Use the preview in the result to discuss the contents.
- "Show me that picture/file again" → call showSavedFiles; saved files appear in the notes as [artifact/...] entries. Never describe a saved image from memory when you can display it.`;

// Guidance shared by every provider about Goobster's own documentation.
// The model is the software the docs describe, so questions about how it
// works, how to configure it, and why one of its features misbehaves are
// answered from the manual, not from a guess.
const SELF_DOCS_GUIDANCE = `**YOUR OWN DOCUMENTATION:**
You are Goobster, and your documentation is available through consultDocs. When someone asks how you work, what a command/feature/room does, how to set up or configure you (config.json, environment variables, Raspberry Pi, Docker, Postgres, the portal, voice, music), or when one of your own tools fails or a feature is disabled or unavailable, call consultDocs (action="search") before answering and cite the doc title. Your skill guides (consultDocs action="list", kind="skill") are step-by-step procedures - troubleshooting tactics, project examples, working guidelines - read the relevant one in full before doing that kind of job. Results marked "decision" are decision records and plans - they describe history or intended future work, not what you can do today; when one is your only source, say the feature is planned rather than presenting it as available. Never invent configuration keys, commands, or behaviour: if the docs do not cover something, say so.`;

/** The self-docs block, or nothing when the operator disabled the corpus (the tool is absent too). */
function selfDocsGuidance() {
    try {
        if (!require('../config/selfDocsConfig').enabled) return '';
    } catch {
        return '';
    }
    return `${SELF_DOCS_GUIDANCE}\n\n`;
}

// When the model finds it has no tool for what it was asked, it says so
// and records the gap for the operator (documentation/capability_gaps.md).
const CAPABILITY_GAP_GUIDANCE = `**WHEN YOU CANNOT DO SOMETHING:**
If you are asked to do something and, after checking your tools (and consultDocs), none of them can do it, call noteCapabilityGap once with a short generic description of the missing capability (no names, content or links), then tell the person plainly what you cannot do and offer the closest thing you can. Never pretend to have done it, and never write a long plan of steps you cannot take in place of saying so.`;

// Guidance shared by every provider about routing scheduling requests.
// Recurring work must land on durable automations (restart-safe, repeat
// until cancelled) - a chain of one-time follow-ups is never a schedule.
// Follow-ups are reminders: one-shot by default, optionally repeating a
// fixed note, but a delivery never runs tools. Watches are the third
// primitive: they wait for a condition rather than a clock, so caring about
// an outcome never becomes a cron job that polls for it.
const SCHEDULING_GUIDANCE = `**SCHEDULING REQUESTS:**
- Recurring WORK - anything that must check, fetch, generate, or act on each run ("check the lab feed every hour and post a status", "daily market summary") → use manageAutomations. Each run is a full agent turn with tools; automations survive restarts and repeat until cancelled.
- A simple recurring reminder that just reposts a fixed note ("remind me to stretch every hour") → use scheduleFollowUp with repeat.
- A single future check-in ("remind me tomorrow at 3pm") → use scheduleFollowUp without repeat. It fires exactly once.
- Waiting for an OUTCOME rather than a time ("run this overnight and tell me whether the bifurcation persists", "let me know how that job turns out") → use watchFor. It waits for the condition itself and fires one full turn when it happens. Never wrap a one-off outcome in a polling automation.
- Unfinished business worth remembering but not scheduling ("I still need to finish the demo code", "waiting to hear back about CI") → use trackAttention. It records that something matters so you can notice later when it goes stale or becomes urgent; it schedules nothing.
- NEVER simulate recurrence by chaining one-time follow-ups; recurring workflows must be automations or repeating reminders.`;

// Project operations use focused tools; executePlan is an optional batching adapter.
const PROJECT_GUIDANCE = `**PROJECTS AND SAVING APPS (when these tools are available):**
- Prefer the specific tool directly. projectAssets organizes projects and versioned apps/scripts/notes without code execution; observatory handles execution, workspace files, history, repos, triggers and missions.
- Save a NEW app: projectAssets {action:"save_app", project:"<existing slug>", name:"<title>", language:"html", code:"<complete HTML document>"}. code is source, not a path, URL, prose or fenced Markdown. SVG apps use language:"svg". save_script accepts python/javascript; save_note accepts markdown.
- File an EXISTING Chat app unchanged: projectAssets action="list_unfiled_apps", then action="file_app" with the selected contentHash OR appletId and the target project. Copy the returned identifier exactly; do not regenerate or abbreviate the app. If ambiguous, ask which app.
- Find the target with list_projects; create_project only when a new project is requested. Copy owner when a slug is ambiguous. For updates, list_assets then get_asset (slug, optional version/offset/limit), preserve existing behavior and save to the SAME slug for a new version.
- An HTML chat preview, saveArtifact (knowledge attachment), a workspace file, and a project app asset are different. Only a successful projectAssets save_app/file_app or observatory save_app result confirms it was saved in the project's Apps view. Never claim a save from a code block alone.
- For project state use observatory inspect; workspace discovery uses files/search/read; stored scripts use run_script; runs use run/status; project automation uses set_trigger; durable outcomes use mission. A Project Mission is not executePlan.
- If a tool is absent or reports an error, explain the restriction, consultDocs and preserve the user's work. executePlan cannot unlock a disabled tool. Never report success until the tool confirms it. Read the Project tool guide via consultDocs for examples and recovery.`;

const EXECUTE_PLAN_GUIDANCE = `**OPTIONAL TOOL BATCHING:**
Call tools directly by default, read their results, then choose the next call. Use executePlan only for a known batch that benefits from earlier-result interpolation; do not wrap a single save or inspection.
A plan contains all steps in order with {name, args}. References use \${step1} for the whole first result, or \${step1.field} only when that result actually has that structured field. Most observatory results are human-readable text, not objects. forEach requires an actual returned array; do not invent fields from prose. Later results cannot be referenced by earlier steps. Set stopOnError=true for dependent operations. It is not a durable project plan or a substitute for specific tools.`;

/**
 * System guidance for providers with NATIVE function calling. The tool
 * schemas themselves are sent via the API's tools parameter, so this only
 * covers usage guidance the model cannot infer from schemas alone.
 * @returns {string}
 */
function buildNativeToolGuidance() {
    return `You are an AI assistant with access to powerful tools. When a user asks you to perform an action that matches one of your available tools, use the tool instead of describing what you would do.

${NOTES_GUIDANCE}

${selfDocsGuidance()}${CAPABILITY_GAP_GUIDANCE}

${SCHEDULING_GUIDANCE}

${PROJECT_GUIDANCE}\n\n${EXECUTE_PLAN_GUIDANCE}`;
}

/**
 * Full JSON-protocol system prompt for providers WITHOUT native function
 * calling. Includes tool schemas as text plus the response protocol.
 * @param {Array} functions - OpenAI-style function definitions
 * @returns {string}
 */
function buildPromptBasedToolPrompt(functions) {
    return `You are an AI assistant with access to powerful tools. When a user asks you to perform an action that matches one of your available tools, you MUST use the tool instead of just describing what you would do.

When you need to use a tool, respond with ONLY a JSON object in this exact format:

\`\`\`json
{
  "tool_call": {
    "name": "tool_name",
    "arguments": {
      "param1": "value1",
      "param2": "value2"
    }
  }
}
\`\`\`

**Examples:**
- User: "Search for Node.js tutorials" → Use performSearch
- User: "Generate a picture of a cat" → Use generateImage
- User: "Play some music" → Use playTrack

${NOTES_GUIDANCE}

${selfDocsGuidance()}${SCHEDULING_GUIDANCE}

${PROJECT_GUIDANCE}\n\n${EXECUTE_PLAN_GUIDANCE}

Available tools:
${formatToolDocs(functions)}

If the user's request doesn't match any available tools, respond normally with text.`;
}

/**
 * Parse a prompt-based tool call out of a model's text response.
 * @param {string} responseText
 * @returns {{name: string, arguments: Object}|null}
 */
function parseToolCall(responseText) {
    if (!responseText || typeof responseText !== 'string') return null;

    const extract = (parsed) => {
        if (parsed?.tool_call?.name && parsed.tool_call.arguments !== undefined) {
            return { name: parsed.tool_call.name, arguments: parsed.tool_call.arguments };
        }
        if (parsed?.name && parsed.arguments !== undefined) {
            return { name: parsed.name, arguments: parsed.arguments };
        }
        return null;
    };

    // Prefer fenced JSON blocks
    const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
    if (jsonMatch) {
        try {
            const result = extract(JSON.parse(jsonMatch[1]));
            if (result) return result;
        } catch {
            // fall through to bare-JSON scan
        }
    }

    // Bare JSON without code fences: try the whole response, then the
    // outermost brace-to-brace span (handles nested objects correctly,
    // unlike a lazy regex).
    const candidates = [responseText.trim()];
    const first = responseText.indexOf('{');
    const last = responseText.lastIndexOf('}');
    if (first !== -1 && last > first) {
        candidates.push(responseText.slice(first, last + 1));
    }
    for (const candidate of candidates) {
        try {
            const result = extract(JSON.parse(candidate));
            if (result) return result;
        } catch {
            continue;
        }
    }

    return null;
}

module.exports = {
    buildNativeToolGuidance,
    buildPromptBasedToolPrompt,
    parseToolCall,
    formatToolDocs
};
