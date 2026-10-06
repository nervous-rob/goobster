const express = require('express');
const attachments = require('../../utils/noteAttachments');
const { safeFileResponseHeaders } = require('../../utils/safeFileResponse');

function mountNoteAttachments(app, ctx, { requireAuth, chatRoute, sendError }) {
    // Authenticate before buffering. Use raw bytes rather than a second multipart parser.
    const raw = express.raw({ type: 'application/octet-stream', limit: attachments.MAX_BYTES });
    app.post('/api/app/note-attachments', requireAuth, (req, res, next) => {
        raw(req, res, error => {
            if (error) return sendError(res, error.status || 400, 'BAD_ATTACHMENT', 'Attachments must be 8 MB or smaller.');
            next();
        });
    }, chatRoute(async req => {
        if (!Buffer.isBuffer(req.body)) throw Object.assign(new Error('Send file bytes as application/octet-stream.'), { status: 400, code: 'BAD_ATTACHMENT' });
        return attachments.save(req.webUser.userId, req.query.name, req.body);
    }));
    app.get('/api/app/note-attachments/:filename', requireAuth, (req, res) => {
        const file = attachments.locate(req.webUser.userId, req.params.filename);
        if (!file) return sendError(res, 404, 'NOT_FOUND', 'Attachment not found.');
        res.set(safeFileResponseHeaders(req.params.filename.slice(33)));
        res.sendFile(file);
    });
    app.delete('/api/app/note-attachments/:filename', requireAuth, chatRoute(async req => {
        attachments.remove(req.webUser.userId, req.params.filename);
        return { deleted: true };
    }));
}
module.exports = { mountNoteAttachments };
