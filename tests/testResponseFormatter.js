/**
 * Simple Response Formatter Test
 * This script tests the responseFormatter's formatPartyCreation method
 */

const responseFormatter = require('../services/adventure/utils/responseFormatter');

// Test data
const testData = {
    partyId: 1,
    leaderId: '123456789012345678',
    leaderName: 'TestUser',
    adventurerName: 'Brave Adventurer',
    backstory: 'A brave adventurer from the land of tests.',
    memberCount: 1,
    maxSize: 4
};

// Main test function
async function runTest() {
    console.log('\n=== TESTING RESPONSE FORMATTER ===\n');
    
    try {
        console.log('Using responseFormatter...');
        
        console.log('\nTesting formatPartyCreation...');
        try {
            const response = responseFormatter.formatPartyCreation(testData);
            
            console.log('\nFORMATTED RESPONSE:');
            console.log(JSON.stringify(response, null, 2));
            
            if (response && response.embeds) {
                console.log('\nTEST PASSED!');
                return true;
            } else {
                console.log('\nTEST FAILED - Invalid response format');
                return false;
            }
        } catch (error) {
            console.error('\nFORMATTING ERROR:', error.message);
            console.log('\nTEST FAILED');
            return false;
        }
    } catch (error) {
        console.error('\nTEST ERROR:', error.message);
        console.log('\nTEST FAILED');
        return false;
    }
}

// Run the test
runTest().then(result => {
    process.exit(result ? 0 : 1);
}).catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
}); 