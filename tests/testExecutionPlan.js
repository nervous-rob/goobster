const toolsRegistry = require('../utils/toolsRegistry');

async function runTest() {
    console.log('\n=== TESTING EXECUTION PLAN ===\n');
    const plan = [
        { name: 'echoMessage', args: { text: 'first' } },
        { name: 'echoMessage', args: { text: 'second' } }
    ];

    try {
        const result = await toolsRegistry.execute('executePlan', { plan });
        if (result.includes('first') && result.includes('second')) {
            console.log('TEST PASSED');
            return true;
        }
        console.log('TEST FAILED');
        return false;
    } catch (err) {
        console.error('Error:', err.message);
        return false;
    }
}

if (require.main === module) {
    runTest().then(success => process.exit(success ? 0 : 1));
}
