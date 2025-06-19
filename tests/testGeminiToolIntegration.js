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
            }
        }
        console.log('Response preview:', JSON.stringify(toolResponse1).substring(0, 200) + '...\n');

        // Test 3: Test tool call parsing with different prompt
        console.log('3. Testing tool call parsing with different prompt...');
        
        const toolResponse2 = await geminiService.chat([
            { role: 'user', content: 'Generate an image of a fantasy castle' }
        ], {
            functions: functionDefs
        });
        
        console.log('✅ Tool parsing test completed via chat method');

        console.log('\n🎉 All tests completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('Stack:', error.stack);
    }
}

// Run the test if this file is executed directly
if (require.main === module) {
    testGeminiToolIntegration();
}

module.exports = { testGeminiToolIntegration }; 