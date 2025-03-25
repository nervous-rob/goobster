import { AIService } from './index';
import { AIServiceConfig } from './types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('AIServiceInstance');

// Default configuration
const defaultConfig: AIServiceConfig = {
    defaultModel: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 1000,
    retryAttempts: 3,
    retryDelay: 1000
};

// Create singleton instance
const aiService = new AIService(defaultConfig);

// Export the singleton instance
export default aiService; 