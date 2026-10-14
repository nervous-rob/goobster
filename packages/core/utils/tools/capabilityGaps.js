/**
 * Chat tool: noteCapabilityGap - Goobster records something he was asked to
 * do and could not, so the operator sees what to build next (Host room).
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */

const AREAS = ['projects', 'repositories', 'chat', 'knowledge', 'discord', 'voice', 'music', 'integrations', 'automations', 'portal', 'other'];

module.exports = {
    noteCapabilityGap: {
        definition: {
            name: 'noteCapabilityGap',
            description:
                'Record that you were asked to do something none of your tools can do (after checking your tools and '
                + 'consultDocs), so the operator can build it. Call it once per missing capability, then tell the person '
                + 'plainly what you cannot do and what the closest thing you CAN do is. Describe the CAPABILITY generically '
                + '("rebase a project clone onto another branch", "attach a PDF to a calendar event") - never the person\'s '
                + 'request, names, content, links or data. Not for errors from a tool that exists (those are already logged) '
                + 'or for things you chose not to do.',
            parameters: {
                type: 'object',
                properties: {
                    capability: { type: 'string', description: 'The missing capability as a short generic phrase (8-160 characters), no personal details' },
                    area: { type: 'string', enum: AREAS, description: 'Which part of Goobster it belongs to' }
                },
                required: ['capability']
            }
        },
        async execute({ capability, area = null }) {
            const result = await require('../../services/capabilityGapService').note({ capability, area });
            if (!result.ok) {
                return result.code === 'TOO_SHORT'
                    ? 'Not recorded: describe the missing capability in a short generic phrase (at least 8 characters).'
                    : 'Not recorded (the backlog is unavailable right now). Still tell the person what you cannot do.';
            }
            return `Recorded as a missing capability for the operator${result.hits > 1 ? ` (reported ${result.hits} times)` : ''}`
                + `${result.status === 'dismissed' ? '; the operator has decided not to build it' : ''}. `
                + 'Now tell the person plainly what you cannot do and offer the closest thing you can.';
        }
    }
};
