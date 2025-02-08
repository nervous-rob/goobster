const mockSentimentAnalyzer = {
    analyzeSentiment: jest.fn().mockResolvedValue({
        sentiment: 'positive',
        dominant_sentiment: 'happy',
        emotions: ['happy', 'excited'],
        confidence: 0.85,
        source: 'ai'
    }),
    _getAIAnalysis: jest.fn().mockResolvedValue({
        sentiment: 'positive',
        dominant_sentiment: 'happy',
        emotions: ['happy', 'excited'],
        confidence: 0.85,
        source: 'ai'
    }),
    _getPatternAnalysis: jest.fn().mockResolvedValue({
        sentiment: 'positive',
        dominant_sentiment: 'happy',
        emotions: ['happy', 'excited'],
        confidence: 0.75,
        source: 'pattern'
    })
}; 