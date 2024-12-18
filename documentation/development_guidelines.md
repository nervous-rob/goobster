# Development Guidelines

## Code Style and Standards

### General Principles
1. **Consistency**
   - Follow existing code patterns
   - Use consistent naming conventions
   - Maintain consistent file structure

2. **Readability**
   - Write self-documenting code
   - Use meaningful variable names
   - Include comments for complex logic

3. **Modularity**
   - Keep functions small and focused
   - Follow single responsibility principle
   - Use modular design patterns

### JavaScript Standards
```javascript
// Function naming - camelCase
async function handleUserInput(input) {
    // Implementation
}

// Constants - UPPER_SNAKE_CASE
const MAX_RETRIES = 3;

// Classes - PascalCase
class MessageHandler {
    // Implementation
}
```

## Project Structure

```
goobster/
├── commands/
│   ├── chat/         # Chat-related commands
│   └── utility/      # Utility commands
├── documentation/    # Project documentation
├── config.json       # Configuration file
├── azureDb.js       # Database connection
├── index.js         # Main entry point
└── deploy-commands.js # Command deployment
```

## Command Development

### Creating New Commands
1. Create new file in appropriate directory
2. Implement required interface:
   ```javascript
   module.exports = {
       data: new SlashCommandBuilder()
           .setName('commandname')
           .setDescription('Command description'),
       async execute(interaction) {
           // Command implementation
       }
   };
   ```
3. Test thoroughly
4. Update documentation

### Error Handling
```javascript
try {
    // Command logic
} catch (error) {
    console.error('Error:', error);
    await interaction.reply('User-friendly error message');
}
```

## Database Operations

### Best Practices
1. Use parameterized queries
2. Handle connection properly
3. Implement proper error handling
4. Clean up resources

### Example Pattern
```javascript
try {
    await getConnection();
    const result = await sql.query`
        SELECT * FROM table 
        WHERE id = ${paramValue}
    `;
    // Process result
} catch (error) {
    // Handle error
}
```

## Testing Guidelines

1. **Unit Tests**
   - Test individual components
   - Mock external dependencies
   - Cover edge cases

2. **Integration Tests**
   - Test component interactions
   - Verify database operations
   - Test command flows

3. **Manual Testing**
   - Test in development server
   - Verify user experience
   - Check error handling

## Git Workflow

1. **Branching Strategy**
   - main: Production-ready code
   - develop: Integration branch
   - feature/*: New features
   - bugfix/*: Bug fixes

2. **Commit Messages**
   ```
   feat: Add new conversation feature
   fix: Resolve database connection issue
   docs: Update README
   ```

3. **Pull Requests**
   - Descriptive title
   - Clear description
   - Link related issues

## Deployment Process

1. **Preparation**
   - Update version numbers
   - Update documentation
   - Run tests

2. **Deployment Steps**
   ```bash
   npm run deploy-commands  # Update Discord commands
   npm run build           # Build if needed
   npm start              # Start the bot
   ```

3. **Post-Deployment**
   - Monitor logs
   - Verify functionality
   - Check database migrations

## Security Guidelines

1. **Code Security**
   - Validate user input
   - Use prepared statements
   - Implement rate limiting

2. **Credential Management**
   - Use environment variables
   - Never commit secrets
   - Regular key rotation

3. **Dependencies**
   - Regular updates
   - Security audits
   - Version pinning
  </rewritten_file> 