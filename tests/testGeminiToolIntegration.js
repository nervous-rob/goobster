const geminiService = require('../services/geminiService');
const toolsRegistry = require('../utils/toolsRegistry');

async function testGeminiToolIntegration() {
    console.log('🧪 Testing Gemini Tool Integration...\n');

    try {
        // Test 1: Basic chat without tools
        console.log('1. Testing basic chat without tools...');
        const basicResponse = await geminiService.chat([
            { role: 'user', content: 'Hello! How are you today?' }
        ]);
        console.log('✅ Basic chat response:', basicResponse.substring(0, 100) + '...\n');

        // Test 2: Chat with tool definitions
        console.log('2. Testing chat with tool definitions...');
        const functionDefs = toolsRegistry.getDefinitions();
        console.log(`Available tools: ${functionDefs.map(f => f.name).join(', ')}`);
        
        const toolResponse1 = await geminiService.chat([
            { role: 'user', content: 'Can you search for information about JavaScript closures?' }
        ], {
            functions: functionDefs
        });

        console.log('✅ Tool-aware response received');
        console.log('Response type:', typeof toolResponse1);
        
        if (toolResponse1.choices && toolResponse1.choices[0]) {
            const choice = toolResponse1.choices[0];
            console.log('Finish reason:', choice.finish_reason);
            console.log('Has function call:', !!choice.message?.function_call);
            
            if (choice.message?.function_call) {
                console.log('Function call detected:', choice.message.function_call.name);
                console.log('Function arguments:', choice.message.function_call.arguments);
            }
        }
        console.log('Response preview:', JSON.stringify(toolResponse1).substring(0, 200) + '...\n');

        // Test 3: Test Azure DevOps tool integration specifically
        console.log('3. Testing Azure DevOps tool integration...');
        
        const devopsResponse = await geminiService.chat([
            { role: 'user', content: 'Create a bug work item titled "Fix login issue" with description "Users cannot log in after password reset"' }
        ], {
            functions: functionDefs
        });
        
        console.log('✅ Azure DevOps tool test completed');
        console.log('Response type:', typeof devopsResponse);
        
        if (devopsResponse.choices && devopsResponse.choices[0]) {
            const choice = devopsResponse.choices[0];
            console.log('Finish reason:', choice.finish_reason);
            console.log('Has function call:', !!choice.message?.function_call);
            
            if (choice.message?.function_call) {
                console.log('DevOps Function call detected:', choice.message.function_call.name);
                console.log('DevOps Function arguments:', choice.message.function_call.arguments);
                
                // Try to parse the arguments to validate structure
                try {
                    const args = JSON.parse(choice.message.function_call.arguments);
                    console.log('Parsed arguments:', args);
                } catch (parseError) {
                    console.warn('Failed to parse function arguments:', parseError.message);
                }
            }
        }

        // Test 4: Test tool call parsing with different prompt patterns
        console.log('\n4. Testing various tool call patterns...');
        
        const patterns = [
            'Generate an image of a fantasy castle',
            'Play the song "Bohemian Rhapsody" by Queen',
            'Set my nickname to "TestUser"',
            'Query Azure DevOps for all bugs assigned to me'
        ];
        
        for (let i = 0; i < patterns.length; i++) {
            console.log(`  4.${i + 1}. Testing pattern: "${patterns[i]}"`);
            try {
                const response = await geminiService.chat([
                    { role: 'user', content: patterns[i] }
                ], {
                    functions: functionDefs
                });
                
                if (response.choices && response.choices[0] && response.choices[0].message?.function_call) {
                    console.log(`    ✅ Tool detected: ${response.choices[0].message.function_call.name}`);
                } else {
                    console.log(`    ℹ️  No tool call detected, got text response`);
                }
            } catch (error) {
                console.error(`    ❌ Error with pattern "${patterns[i]}":`, error.message);
            }
        }
        
        console.log('\n🎉 All tests completed!');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
        
        // Additional debugging information
        console.error('\n🔍 Debug Information:');
        console.error('Error name:', error.name);
        console.error('Error constructor:', error.constructor.name);
        console.error('Is Gemini initialized?:', !!geminiService.ai);
    }
}

// Function to test Azure DevOps service connectivity
async function testAzureDevOpsConnectivity() {
    console.log('\n🔧 Testing Azure DevOps Service Connectivity...');
    
    const azureDevOpsService = require('../services/azureDevOpsService');
    
    // Test the service structure
    console.log('Azure DevOps Service methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(azureDevOpsService)));
    
    // Test connection storage (without actual connection)
    try {
        azureDevOpsService.connect('test-user', 'https://dev.azure.com/testorg', 'testproject', 'fake-token');
        const connection = azureDevOpsService.getConnection('test-user');
        console.log('✅ Connection storage works:', !!connection);
        console.log('Connection details:', { 
            hasOrgUrl: !!connection.orgUrl,
            hasProject: !!connection.project,
            hasToken: !!connection.token 
        });
    } catch (error) {
        console.error('❌ Connection test failed:', error.message);
    }
}

// Run the test if this file is executed directly
if (require.main === module) {
    testGeminiToolIntegration()
        .then(() => testAzureDevOpsConnectivity())
        .catch(console.error);
}

module.exports = { testGeminiToolIntegration, testAzureDevOpsConnectivity }; 