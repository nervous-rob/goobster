# Search Service Documentation

## Overview
Goobster integrates with Perplexity AI to provide intelligent web search capabilities. The service is designed to deliver accurate, context-aware search results with natural language processing.

## Components

### 1. Perplexity Service (`perplexityService.js`)
- Manages web search requests
- Handles API interactions
- Features:
  ```javascript
  {
    model: 'sonar-pro',
    maxTokens: 4096,
    temperature: 0.7
  }
  ```

## Configuration

### 1. API Setup
```json
{
    "perplexityKey": "your_perplexity_api_key"
}
```

### 2. Environment Variables
```bash
PERPLEXITY_API_KEY=your_perplexity_api_key
```

## Features

### 1. Search Capabilities
- Natural language queries
- Context-aware responses
- Detailed or concise options
- Real-time web search

### 2. Response Formatting
- Structured responses
- Markdown support
- Source attribution
- Error handling

## Usage

### 1. Basic Search
```javascript
const result = await perplexityService.search(query);
```

### 2. Command Interface
```
/search query:"What is quantum computing?" detailed:true
```

## Error Handling

### 1. Common Issues
- Invalid API key
- Rate limiting
- Network errors
- Invalid model configuration

### 2. Recovery Strategies
```javascript
try {
    const response = await perplexityService.search(query);
} catch (error) {
    if (error.response?.data?.error?.type === 'invalid_model') {
        // Handle model configuration error
    } else if (!this.apiKey) {
        // Handle missing API key
    }
    // Handle other errors
}
```

## Best Practices

### 1. Query Construction
- Be specific and clear
- Include relevant context
- Use natural language
- Avoid overly complex queries

### 2. Response Handling
- Validate response format
- Handle errors gracefully
- Provide user feedback
- Cache responses when appropriate

### 3. Rate Limiting
- Monitor API usage
- Implement backoff strategies
- Cache frequent queries
- Handle rate limit errors

## Performance

### 1. Optimization
- Response caching
- Query validation
- Error recovery
- Resource cleanup

### 2. Monitoring
- API response times
- Error rates
- Usage patterns
- Rate limit status

## Security

### 1. API Key Management
- Secure storage
- Environment variables
- Key rotation
- Access control

### 2. Request Validation
- Input sanitization
- Query length limits
- Content filtering
- Response validation

## Integration

### 1. Discord Commands
- `/search` command
- Query parameter
- Detailed option
- Response formatting

### 2. Error Messages
- User-friendly errors
- Technical details
- Recovery suggestions
- Support information

## Future Improvements

### 1. Features
- Advanced search filters
- Custom response formats
- Multi-language support
- Search history

### 2. Performance
- Response caching
- Query optimization
- Batch processing
- Load balancing

### 3. User Experience
- Search suggestions
- Result previews
- Interactive responses
- Custom formatting

## Testing

### 1. Unit Tests
- Query validation
- Response parsing
- Error handling
- Rate limiting

### 2. Integration Tests
- API connectivity
- Response formatting
- Command integration
- Error scenarios

## Deployment

### 1. Requirements
- Perplexity API key
- Environment setup
- Rate limit configuration
- Error handling setup

### 2. Monitoring
- API usage tracking
- Error logging
- Performance metrics
- Usage analytics 