/**
 * Test script to diagnose party lookup issues
 * This script tests the findPartyByMember functionality
 */

// Import required modules
const PartyManager = require('../services/adventure/managers/partyManager');
const PartyRepository = require('../services/adventure/repositories/partyRepository');
const { executeTransaction } = require('../azureDb');
const sql = require('mssql');
const logger = require('../services/adventure/utils/logger');

// Create instances
const partyManager = new PartyManager();
const partyRepository = new PartyRepository();

// Mock user ID (use your Discord ID here to test with your account)
const TEST_USER_ID = process.argv[2] || '358083857112629258'; // Default to your ID or pass as argument

// Helper to log results in a formatted way
function logResult(message, data = null, error = null) {
    console.log('\n-----------------------------------------');
    console.log(`[${new Date().toISOString()}] ${message}`);
    
    if (data) {
        console.log('\nData:');
        console.log(JSON.stringify(data, null, 2));
    }
    
    if (error) {
        console.log('\nError:');
        console.log(error.message);
        console.log(error.stack);
    }
    
    console.log('-----------------------------------------\n');
}

// Test direct repository lookup with proper transaction
async function testRepositoryLookup(userId) {
    logResult('Testing direct repository lookup', { userId });
    
    try {
        // Start a transaction
        const transaction = await partyRepository.beginTransaction();
        
        try {
            // Look up party with transaction
            const party = await partyRepository.findByMember(transaction, userId);
            
            if (party) {
                logResult('Party found in repository with transaction', {
                    partyId: party.id,
                    leaderId: party.leaderId,
                    members: party.members?.length || 0,
                    status: party.status || party.adventureStatus
                });
            } else {
                logResult('No party found in repository with transaction', { userId });
            }
            
            await transaction.commit();
            return party;
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        logResult('Repository lookup failed', null, error);
        return null;
    }
}

// Test manager lookup (what disbandParty.js uses)
async function testManagerLookup(userId) {
    logResult('Testing party manager lookup', { userId });
    
    try {
        const party = await partyManager.findPartyByMember(userId);
        
        if (party) {
            logResult('Party found in manager', {
                partyId: party.id,
                leaderId: party.leaderId,
                members: party.members?.length || 0,
                status: party.status || party.adventureStatus
            });
        } else {
            logResult('No party found in manager', { userId });
        }
        
        return party;
    } catch (error) {
        logResult('Manager lookup failed', null, error);
        return null;
    }
}

// Test cached manager lookup after ensuring cache is populated
async function testCachedLookup(userId) {
    logResult('Testing cached party lookup', { userId });
    
    try {
        // First get all active parties to populate cache
        const repository = await testRepositoryLookup(userId);
        const manager = await testManagerLookup(userId);
        
        // Check cache directly
        let foundInCache = false;
        const userIdStr = userId.toString();
        
        for (const [partyId, party] of partyManager.activeParties.entries()) {
            const partyLeaderId = party.leaderId ? party.leaderId.toString() : null;
            
            if (partyLeaderId === userIdStr) {
                logResult('Found party in cache as leader', { 
                    partyId,
                    leaderId: partyLeaderId
                });
                foundInCache = true;
            }
            
            // Check party members
            if (party.members && party.members.some(m => {
                const memberId = m.userId ? m.userId.toString() : null;
                return memberId === userIdStr;
            })) {
                logResult('Found party in cache as member', { 
                    partyId,
                    userId: userIdStr
                });
                foundInCache = true;
            }
        }
        
        if (!foundInCache) {
            logResult('Party not found in cache', { userId: userIdStr });
        }
        
        return { repository, manager, foundInCache };
    } catch (error) {
        logResult('Cache test failed', null, error);
        return { repository: null, manager: null, foundInCache: false };
    }
}

// Main test function
async function runTests() {
    console.log('===================================================');
    console.log('PARTY LOOKUP DIAGNOSTIC TEST');
    console.log(`Testing with user ID: ${TEST_USER_ID}`);
    console.log('===================================================\n');
    
    // Check that user exists
    try {
        let userExists = false;
        
        await executeTransaction(async (transaction) => {
            const result = await transaction.request()
                .input('discordId', sql.VarChar(255), TEST_USER_ID)
                .query('SELECT id FROM users WITH (NOLOCK) WHERE discordId = @discordId');
                
            userExists = result.recordset.length > 0;
            
            if (userExists) {
                logResult('User exists in database', { 
                    userId: TEST_USER_ID,
                    internalId: result.recordset[0].id 
                });
            } else {
                logResult('User does not exist in database', { userId: TEST_USER_ID });
            }
        });
        
        if (!userExists) {
            logResult('Cannot proceed - user does not exist');
            return;
        }
    } catch (error) {
        logResult('Error checking user existence', null, error);
        return;
    }
    
    // Run the tests
    const repoResult = await testRepositoryLookup(TEST_USER_ID);
    const managerResult = await testManagerLookup(TEST_USER_ID);
    const cacheResult = await testCachedLookup(TEST_USER_ID);
    
    // Summary
    console.log('\n===================================================');
    console.log('TEST SUMMARY');
    console.log('===================================================');
    console.log(`Repository lookup success: ${repoResult !== null}`);
    console.log(`Manager lookup success: ${managerResult !== null}`);
    console.log(`Cache lookup success: ${cacheResult.foundInCache}`);
    console.log(`Mismatch between repo and manager: ${(repoResult !== null) !== (managerResult !== null)}`);
    console.log('===================================================\n');
    
    if ((repoResult !== null) !== (managerResult !== null)) {
        console.log('ISSUE DETECTED: Repository and manager lookups have different results!');
        console.log('This is likely the cause of the disbandParty command issues.');
    }
}

// Run the tests
runTests().then(() => {
    console.log('Tests complete');
    process.exit(0);
}).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
}); 