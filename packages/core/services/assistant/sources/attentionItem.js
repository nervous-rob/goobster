/**
 * Source adapter `attention_item`: the Attention item a responsibility is
 * linked to.
 */

const db = require('../../../db');
const { fingerprint } = require('./fingerprint');

module.exports = {
    async read(responsibility) {
        if (!responsibility.attentionItemId) return [];
        const item = await db.get(
            `SELECT id, userId, state, goal, unresolved, deadlineAt, kind
             FROM attention_items WHERE id = @id`,
            { id: responsibility.attentionItemId }
        );
        if (!item || item.userId !== responsibility.ownerUserId) return [];
        return [{
            sourceId: String(item.id),
            revision: fingerprint([item.state, item.goal, item.unresolved, item.deadlineAt]),
            title: `Linked ${String(item.kind || 'goal').replace(/_/g, ' ')} changed`,
            reason: item.state === 'resolved' ? 'resolved' : 'changed',
            category: 'attention'
        }];
    }
};
