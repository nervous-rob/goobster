# Search Service Documentation

## Overview
Goobster integrates with Perplexity AI to provide intelligent web search capabilities. The service is designed to deliver accurate, context-aware search results with natural language processing.

Goobster includes a powerful web search capability that allows it to retrieve up-to-date information from the internet. This feature is particularly useful for answering questions about current events, recent developments, or factual information that may have changed since the bot's training data cutoff.

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

## Search Commands

### `/search`

The primary command for initiating a web search:

```
/search query:"your search query" detailed:true/false
```

- `query`: The search term or question you want to look up
- `detailed`: (Optional) Set to true for more comprehensive results

### `/requiresearchapproval`

Admin-only command to configure whether search requests require approval:

```
/requiresearchapproval set setting:option
/requiresearchapproval status
```

- `set setting`: Choose between "Require approval for searches" or "Allow searches without approval"
- `status`: Check the current search approval setting for your server

## How Search Works

1. **Detection**: When you chat with Goobster, it uses AI to detect if your question might benefit from a web search. The detection system:
   - Analyzes your message for time-sensitive information needs
   - Identifies requests for current events or factual information
   - Uses the current date and time to ensure search queries are relevant
   - Falls back to keyword detection if AI detection encounters issues

2. **Approval Process**: 
   - If search approval is required (default setting), Goobster will ask for permission before performing the search
   - If search approval is not required, Goobster will automatically perform the search without asking

3. **Results**: Search results are formatted and presented in an easy-to-read format with relevant information

## Configuring Search Approval

Server administrators can control whether searches require approval:

1. **Require Approval (Default)**: All search requests must be approved by a user before execution
   - Provides control over when the bot accesses external information
   - Prevents unnecessary searches

2. **No Approval Required**: Searches execute automatically when needed
   - More seamless experience
   - Faster responses for time-sensitive information

To change this setting, use:
```
/requiresearchapproval set setting:"Allow searches without approval"
```

To revert to requiring approval:
```
/requiresearchapproval set setting:"Require approval for searches"
```

## Best Practices for Search

### Making Effective Search Queries
- Be specific about what information you need
- Include relevant context in your question
- For time-sensitive information, mention if you need the most current data
- Avoid overly complex or multi-part questions in a single query

### Troubleshooting
- If search detection isn't working, try rephrasing your question to be more explicit
- If search results aren't relevant, try a more specific query
- For complex topics, consider breaking down your question into smaller, focused queries

## Technical Details

### Search Integration
- Goobster uses Perplexity AI's search API for web searches
- The system includes the current date and time when generating search queries
- Search results are cached to improve performance for similar queries
- The bot uses a fallback detection system if the primary AI detection fails

## Troubleshooting

- If searches aren't being detected properly, try being more explicit (e.g., "Please search for...")
- If search results seem irrelevant, try rephrasing your query to be more specific
- For any persistent issues, contact your server administrator 