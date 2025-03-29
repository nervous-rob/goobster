/**
 * Simple Party Creation Test
 * This script tests the critical party creation functionality
 */

const PartyManager = require('../services/adventure/managers/partyManager');
const { executeTransaction } = require('../azureDb');
const sql = require('mssql');

// Test data
const testUserId = '123456789012345678';
const testUserName = 'TestUser';
const testAdventurerName = 'Brave Adventurer';
const testBackstory = 'Test backstory';

// Main test function
async function runTest() {
    console.log('\n=== STARTING SIMPLE PARTY TEST ===\n');
    
    try {
        // 1. Make sure user exists
        console.log('Ensuring test user exists...');
        await executeTransaction(async (transaction) => {
            const userResult = await transaction.request()
                .input('discordId', sql.VarChar(255), testUserId)
                .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
                
            if (userResult.recordset.length === 0) {
                console.log('Creating test user...');
                await transaction.request()
                    .input('discordId', sql.VarChar(255), testUserId)
                    .input('username', sql.NVarChar(100), testUserName)
                    .input('discordUsername', sql.NVarChar(100), testUserName)
                    .query(`
                        INSERT INTO users (discordId, username, discordUsername)
                        VALUES (@discordId, @username, @discordUsername);
                    `);
            } else {
                console.log('User already exists, id:', userResult.recordset[0].id);
            }
        });
        
        // 2. Perform cleanup first
        console.log('\nCleaning up existing parties...');
        const partyManager = new PartyManager();
        try {
            await partyManager.forceCleanupUserPartyRecords(testUserId);
            console.log('Cleanup completed successfully');
        } catch (cleanupError) {
            console.error('Cleanup failed:', cleanupError.message);
            // Continue with test even if cleanup fails
        }
        
        // 3. Create a party
        console.log('\nCreating test party...');
        try {
            const party = await partyManager.createParty({
                leaderId: testUserId,
                adventurerName: testAdventurerName,
                backstory: testBackstory,
                settings: {
                    maxSize: 4,
                    minPartySize: 1
                }
            });
            
            if (party && party.id) {
                console.log('\nPARTY CREATED SUCCESSFULLY!');
                console.log('Party ID:', party.id);
                console.log('Leader ID:', party.leaderId);
                console.log('Adventurer Name:', party.adventurerName);
                console.log('Status:', party.adventureStatus);
                console.log('Members:', party.members.length);
                
                // Now try to clean it up
                console.log('\nCleaning up created party...');
                await partyManager.forceCleanupUserPartyRecords(testUserId);
                console.log('Final cleanup completed');
                
                console.log('\n=== TEST PASSED ===');
                return true;
            } else {
                console.log('\nPARTY CREATION FAILED: No valid party returned');
                console.log('\n=== TEST FAILED ===');
                return false;
            }
        } catch (error) {
            console.error('\nPARTY CREATION ERROR:', error.message);
            console.log('\n=== TEST FAILED ===');
            return false;
        }
    } catch (error) {
        console.error('\nTEST ERROR:', error.message);
        console.log('\n=== TEST FAILED ===');
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