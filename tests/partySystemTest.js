/**
 * Party System Test Script
 * 
 * This script tests the full party lifecycle:
 * 1. Creating a party
 * 2. Joining a party
 * 3. Getting party status
 * 4. Disbanding a party
 * 
 * Run this script to diagnose issues with the party system.
 */

const PartyManager = require('../services/adventure/managers/partyManager');
const PartyRepository = require('../services/adventure/repositories/partyRepository');
const { executeTransaction } = require('../azureDb');
const sql = require('mssql');
const logger = require('../services/adventure/utils/logger');

// Create instances
const partyManager = new PartyManager();
const partyRepository = new PartyRepository();

// Configuration
const config = {
    leaderId: process.argv[2] || '358083857112629258', // Default or pass as first arg
    memberIds: process.argv[3] ? [process.argv[3]] : ['386008236744245251'], // Default or pass as second arg
    leaderName: 'Test Leader',
    memberNames: ['Test Member'],
    backstory: 'A test backstory for the party leader.',
    delay: 1000, // Delay between operations (ms)
    cleanup: true // Whether to clean up after tests
};

// Helper functions
function logHeader(title) {
    console.log('\n=========================================================');
    console.log(`${title.toUpperCase()} (${new Date().toISOString()})`);
    console.log('=========================================================');
}

function logStep(message) {
    console.log(`\n>> ${message}`);
}

function logResult(result) {
    console.log('Result:');
    console.log(JSON.stringify(result, null, 2));
}

function logError(error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms || config.delay));
}

// Test functions
async function createParty() {
    logStep('Creating party...');
    try {
        // Force cleanup for the leader first
        if (config.cleanup) {
            logStep('Cleaning up previous party data...');
            await partyManager.forceCleanupUserPartyRecords(config.leaderId);
        }
        
        // Create the party
        const party = await partyManager.createParty({
            leaderId: config.leaderId,
            adventurerName: config.leaderName,
            backstory: config.backstory,
            settings: {
                maxSize: 4,
                minPartySize: 1
            }
        });
        
        logResult(party);
        console.log(`Party created with ID: ${party.id}`);
        return party;
    } catch (error) {
        logError(error);
        return null;
    }
}

async function joinParty(partyId, userId, adventurerName, index = 0) {
    logStep(`Adding member ${index + 1} (${userId}) to party ${partyId}...`);
    try {
        // Clean up user first
        if (config.cleanup) {
            await partyManager.forceCleanupUserPartyRecords(userId);
            await delay(500);
        }
        
        // Add the member
        const result = await partyManager.addMember({
            partyId,
            userId,
            adventurerName,
            backstory: `Backstory for ${adventurerName}`
        });
        
        logResult(result);
        return result;
    } catch (error) {
        logError(error);
        return false;
    }
}

async function getParty(partyId) {
    logStep(`Getting party ${partyId}...`);
    try {
        const party = await partyManager.getParty(partyId);
        logResult(party);
        return party;
    } catch (error) {
        logError(error);
        return null;
    }
}

async function findPartyByMember(userId) {
    logStep(`Finding party for user ${userId}...`);
    try {
        const party = await partyManager.findPartyByMember(userId);
        
        if (party) {
            console.log(`Found party ID: ${party.id}`);
            logResult(party);
        } else {
            console.log('No party found for user');
        }
        
        return party;
    } catch (error) {
        logError(error);
        return null;
    }
}

async function disbandParty(partyId) {
    logStep(`Disbanding party ${partyId}...`);
    try {
        await partyManager.disbandParty(partyId);
        console.log('Party disbanded successfully');
        return true;
    } catch (error) {
        logError(error);
        return false;
    }
}

async function cleanupUsers() {
    logStep('Cleaning up all test users...');
    
    try {
        // Clean leader
        await partyManager.forceCleanupUserPartyRecords(config.leaderId);
        console.log(`Cleaned up leader ${config.leaderId}`);
        
        // Clean members
        for (let i = 0; i < config.memberIds.length; i++) {
            await partyManager.forceCleanupUserPartyRecords(config.memberIds[i]);
            console.log(`Cleaned up member ${config.memberIds[i]}`);
        }
        
        return true;
    } catch (error) {
        logError(error);
        return false;
    }
}

async function verifyDatabaseState() {
    logStep('Verifying database state...');
    
    try {
        await executeTransaction(async (transaction) => {
            // Check parties
            const partyResult = await transaction.request()
                .input('leaderId', sql.VarChar(255), config.leaderId)
                .query(`
                    -- Get internal user ID
                    DECLARE @InternalId INT;
                    SELECT @InternalId = id FROM users WITH (NOLOCK) WHERE discordId = @leaderId;
                    
                    -- Find parties led by this user
                    SELECT p.id, p.leaderId, p.adventureStatus, p.isActive
                    FROM parties p WITH (NOLOCK)
                    WHERE p.leaderId = @InternalId;
                `);
            
            console.log('Parties in database:');
            console.log(partyResult.recordset);
            
            // Check party members
            const memberResult = await transaction.request()
                .input('leaderId', sql.VarChar(255), config.leaderId)
                .input('memberId', sql.VarChar(255), config.memberIds[0])
                .query(`
                    -- Get internal user IDs
                    DECLARE @LeaderId INT, @MemberId INT;
                    
                    SELECT @LeaderId = id FROM users WITH (NOLOCK) WHERE discordId = @leaderId;
                    SELECT @MemberId = id FROM users WITH (NOLOCK) WHERE discordId = @memberId;
                    
                    -- Find party members
                    SELECT pm.partyId, pm.userId, pm.adventurerName, pm.memberType
                    FROM partyMembers pm WITH (NOLOCK)
                    INNER JOIN parties p WITH (NOLOCK) ON pm.partyId = p.id
                    WHERE pm.userId IN (@LeaderId, @MemberId)
                    OR p.leaderId = @LeaderId;
                `);
            
            console.log('Party members in database:');
            console.log(memberResult.recordset);
        });
        
        return true;
    } catch (error) {
        logError(error);
        return false;
    }
}

// Main test function
async function runTests() {
    logHeader('Party System Test');
    
    // Clean up first
    if (config.cleanup) {
        await cleanupUsers();
        await delay();
    }
    
    try {
        // Create a party
        const party = await createParty();
        if (!party) {
            throw new Error('Failed to create party, aborting tests');
        }
        
        const partyId = party.id;
        await delay();
        
        // Add members
        for (let i = 0; i < config.memberIds.length; i++) {
            await joinParty(partyId, config.memberIds[i], config.memberNames[i], i);
            await delay();
        }
        
        // Get party details
        await getParty(partyId);
        await delay();
        
        // Find party by member (leader)
        await findPartyByMember(config.leaderId);
        await delay();
        
        // Find party by member (member)
        await findPartyByMember(config.memberIds[0]);
        await delay();
        
        // Verify database state
        await verifyDatabaseState();
        await delay();
        
        // Disband party
        await disbandParty(partyId);
        await delay();
        
        // Verify disband worked
        const leaderParty = await findPartyByMember(config.leaderId);
        if (leaderParty) {
            console.log('WARNING: Leader still has a party after disband!');
        } else {
            console.log('Leader successfully removed from party');
        }
        
        const memberParty = await findPartyByMember(config.memberIds[0]);
        if (memberParty) {
            console.log('WARNING: Member still has a party after disband!');
        } else {
            console.log('Member successfully removed from party');
        }
        
        // Final verification
        await verifyDatabaseState();
        
        logHeader('Test Completed Successfully');
    } catch (error) {
        logHeader('Test Failed');
        logError(error);
        
        // Attempt cleanup on failure
        if (config.cleanup) {
            logStep('Performing cleanup after failure...');
            await cleanupUsers();
        }
    }
}

// Run the tests
runTests()
    .then(() => {
        console.log('\nTests completed. Exiting...');
        setTimeout(() => process.exit(0), 1000);
    })
    .catch(error => {
        console.error('Fatal error:', error);
        setTimeout(() => process.exit(1), 1000);
    }); 