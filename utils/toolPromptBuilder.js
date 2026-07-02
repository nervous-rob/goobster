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

2. **Gather first, then act**: If a later step depends on data you don't have yet, fetch it in an earlier step:
   - Step 1: Fetch data (e.g. performSearch)
   - Step 2: Use the result via \${step1} references (or forEach if step 1 returned an array)

3. **Reference previous results**: Use \${stepN.field} to access data from step N:
   - \${step1} - The entire result from step 1
   - \${step1.items} - The 'items' array field from step 1's result (when a step returns structured data)
   - \${item.id} - When inside a forEach loop, refers to current item's id property

4. **Complete Example - Find the top song from a movie soundtrack and play it**:
   {
     "name": "executePlan",
     "arguments": {
       "plan": [
         {
           "name": "performSearch",
           "args": {
             "query": "most famous song from the Top Gun soundtrack (artist - title)"
           }
         },
         {
           "name": "playTrack",
           "args": {
             "track": "\${step1}"
           }
         }
       ]
     }
   }

**Common Patterns:**
- "Look something up and act on it" → Fetch first (step 1), then use \${step1...} in step 2
- "Do the same thing to several items" → Produce an array in one step, then forEach over it in the next
- Multiple independent actions → List them as sequential steps in a single executePlan call`;

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
