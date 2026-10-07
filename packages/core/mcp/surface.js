/**
 * The protocol surface one authenticated token gets: its tools, its
 * resources, and the instructions the client shows the model. Both
 * transports build it the same way, so scope can never differ between
 * HTTP and stdio.
 */

const { toolDescriptors, callTool } = require('./tools');
const { listResources, listResourceTemplates, readResource } = require('./resources');
const { features } = require('../features/featureState');

/**
 * Whether this installation serves MCP at all (the `mcp` feature). Both
 * transports ask on every request or message, so a feature that is off
 * answers nothing even if a listener was left bound. Token revocation and
 * privacy never come through here: they live in mcpTokenService and
 * privacyService, which this module does not gate.
 */
function mcpServing() {
    return features.isActive('mcp');
}

const NOT_SERVING = 'MCP is not available on this installation.';

function refuseUnlessServing() {
    if (mcpServing()) return;
    const error = new Error('mcp unavailable');
    error.rpcCode = -32000;
    error.publicMessage = NOT_SERVING;
    throw error;
}

const INSTRUCTIONS = {
    read: 'Goobster MCP is read-only. These tools search the token owner\'s '
        + 'private workspace: documentation, memories, facts, knowledge notes, projects, inbox, '
        + 'expeditions, and research briefs. They do not create, edit, or delete anything.',
    docs: 'Goobster MCP is read-only. This token can read Goobster\'s own documentation only. '
        + 'It has no access to anyone\'s private workspace, and nothing here creates, edits, or deletes anything.'
};

/**
 * @param {{ userId: string, scope?: string }} session
 */
function surfaceFor(session) {
    const scope = session.scope || 'read';
    return {
        instructions: INSTRUCTIONS[scope] || INSTRUCTIONS.docs,
        listTools: () => {
            refuseUnlessServing();
            return toolDescriptors({ scope });
        },
        callTool: (name, args) => {
            refuseUnlessServing();
            return callTool(session.userId, name, args, { scope });
        },
        resources: {
            list: (cursor) => {
                refuseUnlessServing();
                return listResources(session.userId, scope, cursor);
            },
            templates: () => {
                refuseUnlessServing();
                return listResourceTemplates(scope);
            },
            read: (uri) => {
                refuseUnlessServing();
                return readResource(session.userId, scope, uri);
            }
        }
    };
}

module.exports = { surfaceFor, mcpServing, INSTRUCTIONS, NOT_SERVING };
