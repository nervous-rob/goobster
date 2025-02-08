class MockConversationAnalyzer {
    constructor() {
        this.analyzeConversation = jest.fn().mockResolvedValue({
            style: {
                dominant: 'casual',
                confidence: 0.85,
                scores: { casual: 2, formal: 0 }
            },
            sentiment: {
                dominant: 'positive',
                emotions: ['happy', 'excited'],
                intensity: 0.8,
                progression: 'stable'
            },
            energy: {
                level: 'high',
                confidence: 0.9,
                scores: { high: 2, medium: 1, low: 0 }
            },
            context: {
                topics: ['greeting'],
                messageCount: 3,
                averageLength: 15,
                timeSpan: 1000
            },
            confidence: 0.85
        });

        this.trackUserStyle = jest.fn().mockImplementation(async (userId, messages) => {
            const { getConnection } = require('../../azureDb');
            const analysis = await this.analyzeConversation(messages);
            const modelInfo = await this._getCurrentModelInfo(userId);
            
            const db = await getConnection();
            const request = db.request();
            
            await request.query`
                INSERT INTO conversation_analysis (
                    userId,
                    sentiment,
                    style,
                    energy,
                    context,
                    model_id,
                    provider,
                    confidence_scores,
                    analysis_metadata
                ) VALUES (
                    ${userId},
                    ${JSON.stringify(analysis.sentiment)},
                    ${JSON.stringify(analysis.style)},
                    ${JSON.stringify(analysis.energy)},
                    ${JSON.stringify(analysis.context)},
                    ${modelInfo.modelId},
                    ${modelInfo.provider},
                    ${JSON.stringify({
                        sentiment: analysis.sentiment.confidence,
                        style: analysis.style.confidence,
                        energy: analysis.energy.confidence,
                        overall: analysis.confidence
                    })},
                    ${JSON.stringify({
                        version: 'v1',
                        timestamp: new Date().toISOString(),
                        messageCount: messages.length,
                        analysisType: 'full'
                    })}
                )`;
            return true;
        });

        this.getUserAnalysisHistory = jest.fn().mockImplementation((userId, limit = 1) => {
            return Promise.resolve(Array(limit).fill({
                style: 'casual',
                formality: 'low',
                energy: 'high',
                sentiment: 'positive',
                emotions: ['happy', 'excited'],
                timestamp: new Date().toISOString()
            }));
        });

        this._validateMessages = jest.fn().mockReturnValue(true);
        this._updateUserPersonality = jest.fn().mockResolvedValue(true);
        this._getCurrentModelInfo = jest.fn().mockResolvedValue({
            modelId: 'test-model',
            provider: 'test-provider'
        });
        this._analyzeStyle = jest.fn().mockResolvedValue({
            dominant: 'formal',
            confidence: 0.85,
            scores: { formal: 2, casual: 0 }
        });
        this._analyzeEnergy = jest.fn().mockResolvedValue({
            level: 'high',
            confidence: 0.85,
            scores: { high: 2, medium: 1, low: 0 }
        });
    }
}

module.exports = new MockConversationAnalyzer(); 