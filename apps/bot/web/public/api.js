/**
 * Minimal fetch wrapper for the panel API. Server errors carry
 * { error: { code, message, ... } }; this raises them as ApiError so the
 * UI can branch on code (e.g. confirmation-required conflicts).
 */

export class ApiError extends Error {
    constructor(status, body) {
        super(body?.error?.message || `Request failed (${status})`);
        this.name = 'ApiError';
        this.status = status;
        this.code = body?.error?.code || 'UNKNOWN';
        this.details = body?.error || {};
    }
}

async function request(method, path, body) {
    const options = { method, headers: {} };
    if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    let data = null;
    try {
        data = await response.json();
    } catch {
        // Non-JSON body (shouldn't happen on API routes)
    }
    if (!response.ok) {
        throw new ApiError(response.status, data);
    }
    return data;
}

export const api = {
    get: (path) => request('GET', path),
    post: (path, body = {}) => request('POST', path, body),
    patch: (path, body = {}) => request('PATCH', path, body)
};
