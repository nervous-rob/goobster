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
        const params = parameters?.properties ?
            Object.entries(parameters.properties)
                .map(([key, prop]) => `  - ${key}: ${prop.type || 'any'}${prop.description ? ` (${prop.description})` : ''}`)
                .join('\n') : 'No parameters';

        return `**${name}**: ${description || 'No description available'}\nParameters:\n${params}`;
    }).join('\n\n');
}

// Guidance shared by every provider about multi-step executePlan usage.
const EXECUTE_PLAN_GUIDANCE = `**DYNAMIC EXECUTION PLANS:**
When using executePlan for operations that require data from one step to inform later steps:

1. **CRITICAL**: The plan array MUST contain ALL steps in order. Step 2 cannot reference step 1 if step 1 doesn't exist!

2. **Query first, then act**: If you need to act on multiple items but don't know their IDs, query first:
   - Step 1: Query for items with WIQL
   - Step 2: Use forEach with \${step1.workItems} to iterate over results

3. **Reference previous results**: Use \${stepN.field} to access data from step N:
   - \${step1} - The entire result from step 1
   - \${step1.workItems} - The workItems array from step 1 (Azure DevOps WIQL queries return results in a 'workItems' array)
   - \${item.id} - When inside a forEach loop, refers to current item's id property

4. **Complete Example - Assign all work items in project "Spitball" to rob@nervouslabs.com**:
   {
     "name": "executePlan",
     "arguments": {
       "plan": [
         {
           "name": "queryDevOpsWorkItems",
           "args": {
             "wiql": "SELECT [System.Id], [System.Title] FROM WorkItems WHERE [System.TeamProject] = 'Spitball' AND [System.AssignedTo] = ''"
           }
         },
         {
           "name": "updateDevOpsWorkItem",
           "args": {
             "id": "\${item.id}",
             "field": "System.AssignedTo",
             "value": "rob@nervouslabs.com"
           },
           "forEach": "\${step1.workItems}"
         }
       ]
     }
   }

**Common Patterns:**
- "Review and assign all work items" → Query first (step 1), then forEach update (step 2)
- "Add comment to tasks #122, #123, #124" → Use executePlan with multiple steps
- Query MUST include project name: [System.TeamProject] = 'ProjectName'`;

/**
 * System guidance for providers with NATIVE function calling. The tool
 * schemas themselves are sent via the API's tools parameter, so this only
 * covers usage guidance the model cannot infer from schemas alone.
 * @returns {string}
 */
function buildNativeToolGuidance() {
    return `You are an AI assistant with access to powerful tools. When a user asks you to perform an action that matches one of your available tools, use the tool instead of describing what you would do.

${EXECUTE_PLAN_GUIDANCE}`;
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
- User: "Create a bug work item called 'Login broken'" → Use createDevOpsWorkItem
- User: "Search for Node.js tutorials" → Use performSearch
- User: "Generate a picture of a cat" → Use generateImage
- User: "Play some music" → Use playTrack

${EXECUTE_PLAN_GUIDANCE}

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
