const axios = require('axios');

class AzureDevOpsService {
    constructor() {
        this.connections = new Map();
    }

    /**
     * Store a connection for a user
     * @param {string} userId
     * @param {string} orgUrl Organization base URL, e.g. https://dev.azure.com/myorg
     * @param {string} project Project name
     * @param {string} token Personal access token
     */
    connect(userId, orgUrl, project, token) {
        this.connections.set(userId, { orgUrl, project, token });
    }

    getConnection(userId) {
        return this.connections.get(userId);
    }

    async createWorkItem(userId, type, title, description) {
        const conn = this.getConnection(userId);
        if (!conn) throw new Error('Not connected to Azure DevOps');

        const url = `${conn.orgUrl}/${conn.project}/_apis/wit/workitems/$${type}?api-version=7.0`;
        const auth = Buffer.from(`:${conn.token}`).toString('base64');
        const ops = [
            { op: 'add', path: '/fields/System.Title', value: title }
        ];
        if (description) {
            ops.push({ op: 'add', path: '/fields/System.Description', value: description });
        }

        const response = await axios.patch(url, ops, {
            headers: {
                'Content-Type': 'application/json-patch+json',
                'Authorization': `Basic ${auth}`
            }
        });

        return response.data;
    }

    async addComment(userId, workItemId, text) {
        const conn = this.getConnection(userId);
        if (!conn) throw new Error('Not connected to Azure DevOps');
        const url = `${conn.orgUrl}/${conn.project}/_apis/wit/workItems/${workItemId}/comments?api-version=7.0-preview.3`;
        const auth = Buffer.from(`:${conn.token}`).toString('base64');

        const response = await axios.post(url, { text }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            }
        });
        return response.data;
    }

    async getWorkItem(userId, id) {
        const conn = this.getConnection(userId);
        if (!conn) throw new Error('Not connected to Azure DevOps');
        const url = `${conn.orgUrl}/${conn.project}/_apis/wit/workitems/${id}?api-version=7.0`;
        const auth = Buffer.from(`:${conn.token}`).toString('base64');
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Basic ${auth}`
            }
        });
        return response.data;
    }

    async queryWIQL(userId, wiql) {
        const conn = this.getConnection(userId);
        if (!conn) throw new Error('Not connected to Azure DevOps');
        const url = `${conn.orgUrl}/${conn.project}/_apis/wit/wiql?api-version=7.0`;
        const auth = Buffer.from(`:${conn.token}`).toString('base64');
        const response = await axios.post(url, { query: wiql }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${auth}`
            }
        });
        return response.data;
    }

    async updateWorkItem(userId, id, fields) {
        const conn = this.getConnection(userId);
        if (!conn) throw new Error('Not connected to Azure DevOps');
        const url = `${conn.orgUrl}/${conn.project}/_apis/wit/workitems/${id}?api-version=7.0`;
        const auth = Buffer.from(`:${conn.token}`).toString('base64');
        const ops = Object.entries(fields).map(([key, value]) => ({
            op: 'add',
            path: `/fields/${key}`,
            value
        }));
        const response = await axios.patch(url, ops, {
            headers: {
                'Content-Type': 'application/json-patch+json',
                'Authorization': `Basic ${auth}`
            }
        });
        return response.data;
    }
}

module.exports = new AzureDevOpsService();
