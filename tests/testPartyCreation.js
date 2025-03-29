/**
 * Test Party Creation
 * This script tests party creation functionality to verify fixes
 */

// Import required modules
const PartyManager = require('../services/adventure/managers/partyManager');
const { executeTransaction } = require('../azureDb');
const sql = require('mssql');
const logger = require('../services/adventure/utils/logger');

// Mock interaction data
const mockUserId = '123456789012345678'; // Discord ID (large number as string)
const mockUserName = 'TestUser';
const mockAdventurerName = 'Brave Adventurer';
const mockBackstory = 'A brave adventurer from the land of tests.';

// Helper to log results with clear formatting
function logResult(message, data = null, error = null) {
    const timestamp = new Date().toISOString();
    
    console.log('\n-----------------------------------------');
    console.log(`${timestamp} - ${message}`);
    
    if (data) {
        console.log('\nData:');
        console.log(JSON.stringify(data, null, 2));
    }
    
    if (error) {
        console.log('\nError:');
        console.log(error.message);
        if (error.stack) {
            console.log('\nStack:');
            console.log(error.stack);
        }
    }
    
    console.log('-----------------------------------------\n');
}

// Helper to clean up any existing party data for the test user
async function cleanupUserParties(userId) {
    try {
        logResult('Starting cleanup for user', { userId });
        const partyManager = new PartyManager();
        await partyManager.forceCleanupUserPartyRecords(userId);
        logResult('Cleanup completed successfully');
        return true;
    } catch (error) {
        logResult('Cleanup failed', null, error);
        return false;
    }
}

// Test creating a party with a valid user and name
async function testCreateParty(userId, adventurerName, backstory, cleanup = false) {
    try {
        logResult('Starting party creation test', { userId, adventurerName, cleanup });
        
        // Create party manager instance
        const partyManager = new PartyManager();
        
        // Clean up if requested
        if (cleanup) {
            logResult('Running cleanup before party creation');
            await cleanupUserParties(userId);
        }
        
        // Create the party
        logResult('Attempting party creation');
        const party = await partyManager.createParty({
            leaderId: userId,
            adventurerName,
            backstory,
            settings: {
                maxSize: 4,
                minPartySize: 1
            }
        });
        
        // Check the result
        if (party && party.id) {
            logResult('Party created successfully', {
                partyId: party.id,
                leaderId: party.leaderId,
                adventurerName: party.adventurerName,
                members: party.members.length,
                status: party.adventureStatus
            });
            return party;
        } else {
            logResult('Party creation failed - no party ID returned');
            return null;
        }
    } catch (error) {
        logResult('Party creation failed with error', null, error);
        
        // See if we need to handle the "already exists" error with cleanup
        if (error.message && error.message.includes('already have an active party') && !cleanup) {
            logResult('Detected existing party - retrying with cleanup');
            return testCreateParty(userId, adventurerName, backstory, true);
        }
        
        return null;
    }
}

// Test party creation with empty or invalid adventurer name
async function testInvalidAdventurerName() {
    try {
        logResult('Testing invalid adventurer name');
        
        // Create party manager instance
        const partyManager = new PartyManager();
        
        // Test with empty name
        try {
            await partyManager.createParty({
                leaderId: mockUserId,
                adventurerName: '',
                settings: { maxSize: 4 }
            });
            logResult('Test failed - creation succeeded with empty name');
        } catch (error) {
            logResult('Empty name correctly rejected', { errorMessage: error.message });
        }
        
        // Test with null name
        try {
            await partyManager.createParty({
                leaderId: mockUserId,
                adventurerName: null,
                settings: { maxSize: 4 }
            });
            logResult('Test failed - creation succeeded with null name');
        } catch (error) {
            logResult('Null name correctly rejected', { errorMessage: error.message });
        }
        
        // Test with only whitespace
        try {
            await partyManager.createParty({
                leaderId: mockUserId,
                adventurerName: '   ',
                settings: { maxSize: 4 }
            });
            logResult('Test failed - creation succeeded with whitespace name');
        } catch (error) {
            logResult('Whitespace name correctly rejected', { errorMessage: error.message });
        }
        
        logResult('Invalid adventurer name tests complete');
        return true;
    } catch (error) {
        logResult('Invalid adventurer name tests failed', null, error);
        return false;
    }
}

// Test cleanup specifically
async function testCleanupAndCreate() {
    try {
        logResult('Testing cleanup and create flow');
        
        // First create a party
        const party1 = await testCreateParty(mockUserId, mockAdventurerName, mockBackstory);
        if (!party1) {
            logResult('Initial party creation failed, cannot continue test');
            return false;
        }
        
        // Now try to create another without cleanup - should fail
        try {
            const partyManager = new PartyManager();
            await partyManager.createParty({
                leaderId: mockUserId,
                adventurerName: 'Second Adventurer',
                settings: { maxSize: 4 }
            });
            logResult('Test failed - second creation succeeded without cleanup');
        } catch (error) {
            if (error.message.includes('already have an active party')) {
                logResult('Second creation correctly rejected (party exists)', { errorMessage: error.message });
            } else {
                logResult('Second creation failed for unexpected reason', null, error);
                return false;
            }
        }
        
        // Now force cleanup and try again - should succeed
        logResult('Running party cleanup');
        await cleanupUserParties(mockUserId);
        
        const party2 = await testCreateParty(mockUserId, 'Second Adventurer', 'Backstory after cleanup');
        if (party2 && party2.id) {
            logResult('Party created after cleanup', {
                partyId: party2.id,
                leaderId: party2.leaderId,
                adventurerName: party2.adventurerName
            });
            return true;
        } else {
            logResult('Party creation after cleanup failed');
            return false;
        }
    } catch (error) {
        logResult('Cleanup and create test failed', null, error);
        return false;
    }
}

// Ensure the user exists in the database before testing
async function ensureUserExists(userId, username) {
    try {
        logResult('Ensuring test user exists', { userId, username });
        
        await executeTransaction(async (transaction) => {
            // Check if user exists
            const result = await transaction.request()
                .input('discordId', sql.VarChar(255), userId)
                .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
            
            if (result.recordset.length === 0) {
                // Create user
                await transaction.request()
                    .input('discordId', sql.VarChar(255), userId)
                    .input('username', sql.NVarChar(100), username)
                    .input('discordUsername', sql.NVarChar(100), username)
                    .query(`
                        INSERT INTO users (discordId, username, discordUsername)
                        VALUES (@discordId, @username, @discordUsername);
                    `);
                
                logResult('Created test user in database');
            } else {
                logResult('Test user already exists in database', { internalId: result.recordset[0].id });
            }
        });
        
        return true;
    } catch (error) {
        logResult('Failed to ensure user exists', null, error);
        return false;
    }
}

// Main test function
async function runTests() {
    try {
        console.log('\n==================================================');
        console.log('STARTING PARTY CREATION TESTS');
        console.log('==================================================\n');
        
        // Make sure our test user exists
        const userCreated = await ensureUserExists(mockUserId, mockUserName);
        if (!userCreated) {
            console.log('Failed to create test user, aborting tests');
            return;
        }
        
        // Run tests
        await testInvalidAdventurerName();
        await testCleanupAndCreate();
        
        // Final test - successful party creation
        const finalParty = await testCreateParty(mockUserId, 'Final Test Adventurer', 'Final test backstory', true);
        
        console.log('\n==================================================');
        console.log('TEST COMPLETION SUMMARY');
        console.log('==================================================');
        console.log(`Invalid name tests passed: ${await testInvalidAdventurerName() ? 'YES' : 'NO'}`);
        console.log(`Cleanup and create tests passed: ${await testCleanupAndCreate() ? 'YES' : 'NO'}`);
        console.log(`Final party creation passed: ${finalParty !== null ? 'YES' : 'NO'}`);
        console.log('==================================================\n');
        
    } catch (error) {
        console.error('Test suite failed with error:', error);
    }
}

// Run the tests
runTests().then(() => {
    console.log('Tests complete. Exiting.');
}).catch(error => {
    console.error('Unhandled error in test suite:', error);
}); 