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

        console.log('Azure DevOps createWorkItem request:', {
            url,
            type,
            title,
            description,
            operations: ops
        });

        try {
            const response = await axios.patch(url, ops, {
                headers: {
                    'Content-Type': 'application/json-patch+json',
                    'Authorization': `Basic ${auth}`
                }
            });

            console.log('Azure DevOps createWorkItem success:', {
                id: response.data.id,
                url: response.data.url
            });

            return response.data;
        } catch (error) {
            console.error('Azure DevOps createWorkItem error:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                url,
                type,
                title
            });
            throw error;
        }
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
        const url = `${conn.orgUrl}/${conn.project}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.0`;
        const auth = Buffer.from(`:${conn.token}`).toString('base64');
        
        try {
            const response = await axios.get(url, {
                headers: {
                    'Authorization': `Basic ${auth}`
                }
            });
            return response.data;
        } catch (error) {
            console.error('Azure DevOps getWorkItem error:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                url,
                workItemId: id,
                project: conn.project,
                orgUrl: conn.orgUrl
            });
            throw error;
        }
    }

    /**
     * Fetch multiple work items with optional specific fields
     * @param {string} userId
     * @param {number[]} ids
     * @param {string[]} [fields]
     * @returns {Promise<Array>} Array of work item objects
     */
    async getWorkItems(userId, ids, fields = []) {
        const conn = this.getConnection(userId);
        if (!conn) throw new Error('Not connected to Azure DevOps');
        if (!ids.length) return [];
        const idsParam = ids.join(',');
        let url = `${conn.orgUrl}/_apis/wit/workitems?ids=${idsParam}&api-version=7.0`;
        if (fields.length) {
            url += `&fields=${encodeURIComponent(fields.join(','))}`;
        }
        const auth = Buffer.from(`:${conn.token}`).toString('base64');
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Basic ${auth}`
            }
        });
        return response.data.value || [];
    }

    async queryWIQL(userId, wiql) {
        const conn = this.getConnection(userId);
        if (!conn) throw new Error('Not connected to Azure DevOps');
        const url = `${conn.orgUrl}/${conn.project}/_apis/wit/wiql?api-version=7.0`;
        const auth = Buffer.from(`:${conn.token}`).toString('base64');
        
        console.log('Azure DevOps WIQL query request:', {
            url,
            project: conn.project,
            orgUrl: conn.orgUrl,
            query: wiql
        });

        try {
            const response = await axios.post(url, { query: wiql }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${auth}`
                }
            });

            console.log('Azure DevOps WIQL query success:', {
                resultCount: response.data.workItems?.length || 0,
                queryType: response.data.queryType
            });

            return response.data;
        } catch (error) {
            console.error('Azure DevOps WIQL query error:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                url,
                project: conn.project,
                orgUrl: conn.orgUrl,
                query: wiql
            });
            throw error;
        }
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

        console.log('Azure DevOps updateWorkItem request:', {
            url,
            workItemId: id,
            project: conn.project,
            orgUrl: conn.orgUrl,
            operations: ops
        });

        try {
            const response = await axios.patch(url, ops, {
                headers: {
                    'Content-Type': 'application/json-patch+json',
                    'Authorization': `Basic ${auth}`
                }
            });

            console.log('Azure DevOps updateWorkItem success:', {
                id: response.data.id,
                url: response.data.url
            });

            return response.data;
        } catch (error) {
            console.error('Azure DevOps updateWorkItem error:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                url,
                workItemId: id,
                project: conn.project,
                orgUrl: conn.orgUrl,
                operations: ops
            });
            throw error;
        }
    }

    async setParent(userId, childId, parentId) {
        const conn = this.getConnection(userId);
        if (!conn) throw new Error('Not connected to Azure DevOps');
        
        const url = `${conn.orgUrl}/${conn.project}/_apis/wit/workitems/${childId}?api-version=7.0`;
        const auth = Buffer.from(`:${conn.token}`).toString('base64');
        
        console.log('Azure DevOps setParent request:', {
            url,
            childId,
            parentId,
            project: conn.project
        });

        try {
            // First, get the work item to check for existing parent relations
            const workItem = await this.getWorkItem(userId, childId);
            
            const ops = [];
            
            // If there are existing relations, find and remove any parent relation
            if (workItem.relations && workItem.relations.length > 0) {
                workItem.relations.forEach((relation, index) => {
                    if (relation.rel === 'System.LinkTypes.Hierarchy-Reverse') {
                        ops.push({
                            op: 'remove',
                            path: `/relations/${index}`
                        });
                    }
                });
            }
            
            // Add the new parent relation
            ops.push({
                op: 'add',
                path: '/relations/-',
                value: {
                    rel: 'System.LinkTypes.Hierarchy-Reverse',
                    url: `${conn.orgUrl}/${conn.project}/_apis/wit/workItems/${parentId}`,
                    attributes: {
                        comment: 'Setting parent work item'
                    }
                }
            });
            
            const response = await axios.patch(url, ops, {
                headers: {
                    'Content-Type': 'application/json-patch+json',
                    'Authorization': `Basic ${auth}`
                }
            });
            
            console.log('Azure DevOps setParent success:', {
                childId,
                parentId,
                operationsCount: ops.length
            });
            
            return response.data;
        } catch (error) {
            console.error('Azure DevOps setParent error:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                url,
                childId,
                parentId,
                project: conn.project
            });
            throw error;
        }
    }
}

module.exports = new AzureDevOpsService();