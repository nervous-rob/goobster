const geminiService = require('../services/geminiService');
const toolsRegistry = require('../utils/toolsRegistry');

async function testGeminiToolIntegration() {
    console.log('🧪 Testing Gemini Tool Integration (native function calling)...\n');

    try {
        // Test 1: Basic chat without tools
        console.log('1. Testing basic chat without tools...');
        const basicResponse = await geminiService.chat([
            { role: 'user', content: 'Hello! How are you today?' }
        ]);
        console.log('✅ Basic chat response:', basicResponse.content.substring(0, 100) + '...\n');

        // Test 2: Chat with tool definitions
        console.log('2. Testing chat with tool definitions...');
        const functionDefs = toolsRegistry.getDefinitions();
        console.log(`Available tools: ${functionDefs.map(f => f.name).join(', ')}`);

        const toolResponse = await geminiService.chat([
            { role: 'user', content: 'Can you search for information about JavaScript closures?' }
        ], {
            functions: functionDefs
        });

        console.log('✅ Tool-aware response received');
        console.log('Tool calls:', toolResponse.toolCalls.length);
        for (const call of toolResponse.toolCalls) {
            console.log('  Tool call detected:', call.name, call.arguments);
        }
        if (toolResponse.content) {
            console.log('Text preview:', toolResponse.content.substring(0, 200) + '...');
        }
        console.log();

        // Test 3: Azure DevOps tool integration specifically
        console.log('3. Testing Azure DevOps tool integration...');

        const devopsResponse = await geminiService.chat([
            { role: 'user', content: 'Create a bug work item titled "Fix login issue" with description "Users cannot log in after password reset"' }
        ], {
            functions: functionDefs
        });

        console.log('✅ Azure DevOps tool test completed');
        console.log('Tool calls:', devopsResponse.toolCalls.length);
        for (const call of devopsResponse.toolCalls) {
            console.log('  DevOps tool call detected:', call.name);
            try {
                console.log('  Parsed arguments:', JSON.parse(call.arguments));
            } catch (parseError) {
                console.warn('  Failed to parse function arguments:', parseError.message);
            }
        }

        // Test 4: Tool call round trip (feed result back for a final answer)
        if (devopsResponse.toolCalls.length > 0) {
            console.log('\n4. Testing tool result round trip...');
            const call = devopsResponse.toolCalls[0];
            const followUp = await geminiService.chat([
                { role: 'user', content: 'Create a bug work item titled "Fix login issue" with description "Users cannot log in after password reset"' },
                { role: 'assistant', content: devopsResponse.content, toolCalls: devopsResponse.toolCalls },
                { role: 'tool', toolCallId: call.id, name: call.name, content: '✅ Created Bug #123: Fix login issue' }
            ], {
                functions: functionDefs
            });
            console.log('✅ Round-trip response:', followUp.content.substring(0, 150) + '...');
        }

        // Test 5: Various tool call patterns
        console.log('\n5. Testing various tool call patterns...');

        const patterns = [
            'Generate an image of a fantasy castle',
            'Play the song "Bohemian Rhapsody" by Queen',
            'Set my nickname to "TestUser"',
            'Query Azure DevOps for all bugs assigned to me'
        ];

        for (let i = 0; i < patterns.length; i++) {
            console.log(`  5.${i + 1}. Testing pattern: "${patterns[i]}"`);
            try {
                const response = await geminiService.chat([
                    { role: 'user', content: patterns[i] }
                ], {
                    functions: functionDefs
                });

                if (response.toolCalls.length > 0) {
                    console.log(`    ✅ Tool detected: ${response.toolCalls.map(c => c.name).join(', ')}`);
                } else {
                    console.log('    ℹ️  No tool call detected, got text response');
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
        console.error('Is Gemini configured?:', geminiService.isConfigured());
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
