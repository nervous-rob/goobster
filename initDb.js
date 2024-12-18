const { sql, getConnection } = require('./azureDb');

async function dropTablesIfExist() {
    try {
        console.log('Attempting to connect to database...');
        await getConnection();
        console.log('Connected successfully. Dropping existing tables...');
        
        // First, drop all foreign key constraints
        console.log('Dropping foreign key constraints...');
        const dropFKQuery = `
            DECLARE @SQL NVARCHAR(MAX) = N'';
            SELECT @SQL += N'
                ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id))
                + '.' + QUOTENAME(OBJECT_NAME(parent_object_id)) + 
                ' DROP CONSTRAINT ' + QUOTENAME(name) + ';'
            FROM sys.foreign_keys;
            EXEC sp_executesql @SQL;
        `;
        await sql.query(dropFKQuery);
        console.log('Foreign key constraints dropped successfully.');
        
        // Now drop tables in reverse order of dependencies
        const dropQueries = [
            // First drop tables that depend on others
            "IF OBJECT_ID('decisionPoints', 'U') IS NOT NULL DROP TABLE decisionPoints;",
            "IF OBJECT_ID('adventurerStates', 'U') IS NOT NULL DROP TABLE adventurerStates;",
            "IF OBJECT_ID('adventures', 'U') IS NOT NULL DROP TABLE adventures;",
            "IF OBJECT_ID('partyMembers', 'U') IS NOT NULL DROP TABLE partyMembers;",
            "IF OBJECT_ID('parties', 'U') IS NOT NULL DROP TABLE parties;",
            "IF OBJECT_ID('messages', 'U') IS NOT NULL DROP TABLE messages;",
            "IF OBJECT_ID('conversations', 'U') IS NOT NULL DROP TABLE conversations;",
            "IF OBJECT_ID('prompts', 'U') IS NOT NULL DROP TABLE prompts;",
            "IF OBJECT_ID('users', 'U') IS NOT NULL DROP TABLE users;"
        ];

        // Execute each drop query separately
        for (const query of dropQueries) {
            try {
                await sql.query(query);
                console.log(`Successfully executed: ${query}`);
            } catch (err) {
                console.error(`Error executing query: ${query}`, err);
                throw err;
            }
        }
        
        console.log('All tables dropped successfully.');
    } catch (error) {
        console.error('Failed to drop tables:', error);
        throw error;
    }
}

async function createUsersTable() {
    try {
        await getConnection();
        const query = `
            CREATE TABLE users (
                id INT PRIMARY KEY IDENTITY(1,1),
                username NVARCHAR(50) NOT NULL,
                joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
                activeConversationId INT
            );
        `;
        await sql.query(query);
        console.log('Users table created successfully.');
    } catch (error) {
        console.error('Failed to create users table:', error);
    }
}

async function createPromptsTable() {
    try {
        await getConnection();
        const query = `
            CREATE TABLE prompts (
                id INT PRIMARY KEY IDENTITY(1,1),
                userId INT NOT NULL,
                prompt NVARCHAR(MAX) NOT NULL,
                label NVARCHAR(50),
                FOREIGN KEY (userId) REFERENCES users(id)
            );
        `;
        await sql.query(query);
        console.log('Prompts table created successfully.');
    } catch (error) {
        console.error('Failed to create prompts table:', error);
    }
}

async function createConversationsTable() {
    try {
        await getConnection();
        const query = `
            CREATE TABLE conversations (
                id INT PRIMARY KEY IDENTITY(1,1),
                userId INT NOT NULL,
                promptId INT,
                FOREIGN KEY (userId) REFERENCES users(id),
                FOREIGN KEY (promptId) REFERENCES prompts(id)
            );
        `;
        await sql.query(query);
        console.log('Conversations table created successfully.');
    } catch (error) {
        console.error('Failed to create conversations table:', error);
    }
}

async function addForeignKeyToUsersTable() {
    try {
        await getConnection();
        const query = `
            ALTER TABLE users
            ADD FOREIGN KEY (activeConversationId) REFERENCES conversations(id);
        `;
        await sql.query(query);
        console.log('Foreign key added to users table successfully.');
    } catch (error) {
        console.error('Failed to add foreign key to users table:', error);
    }
}

async function createMessagesTable() {
    try {
        await getConnection();
        const query = `
            CREATE TABLE messages (
                id INT PRIMARY KEY IDENTITY(1,1),
                conversationId INT NOT NULL,
                message NVARCHAR(MAX) NOT NULL,
                createdAt DATETIME NOT NULL DEFAULT GETDATE(),
                FOREIGN KEY (conversationId) REFERENCES conversations(id)
            );
        `;
        await sql.query(query);
        console.log('Messages table created successfully.');
    } catch (error) {
        console.error('Failed to create messages table:', error);
    }
}

async function createPartiesTable() {
    try {
        await getConnection();
        const query = `
            CREATE TABLE parties (
                id INT PRIMARY KEY IDENTITY(1,1),
                createdAt DATETIME NOT NULL DEFAULT GETDATE(),
                isActive BIT NOT NULL DEFAULT 1,
                adventureStatus VARCHAR(20) DEFAULT 'RECRUITING'
            );
        `;
        await sql.query(query);
        console.log('Parties table created successfully.');
    } catch (error) {
        console.error('Failed to create parties table:', error);
    }
}

async function createPartyMembersTable() {
    try {
        await getConnection();
        const query = `
            CREATE TABLE partyMembers (
                id INT PRIMARY KEY IDENTITY(1,1),
                partyId INT NOT NULL,
                userId INT NOT NULL,
                adventurerName NVARCHAR(50) NOT NULL,
                backstory NVARCHAR(MAX),
                joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
                FOREIGN KEY (partyId) REFERENCES parties(id),
                FOREIGN KEY (userId) REFERENCES users(id)
            );
        `;
        await sql.query(query);
        console.log('PartyMembers table created successfully.');
    } catch (error) {
        console.error('Failed to create partyMembers table:', error);
    }
}

async function createAdventuresTable() {
    try {
        await getConnection();
        const query = `
            CREATE TABLE adventures (
                id INT PRIMARY KEY IDENTITY(1,1),
                partyId INT NOT NULL,
                theme NVARCHAR(100) NOT NULL,
                plotSummary NVARCHAR(MAX) NOT NULL,
                winCondition NVARCHAR(MAX) NOT NULL,
                currentState NVARCHAR(MAX),
                startedAt DATETIME NOT NULL DEFAULT GETDATE(),
                completedAt DATETIME,
                FOREIGN KEY (partyId) REFERENCES parties(id)
            );
        `;
        await sql.query(query);
        console.log('Adventures table created successfully.');
    } catch (error) {
        console.error('Failed to create adventures table:', error);
    }
}

async function createAdventurerStatesTable() {
    try {
        await getConnection();
        const query = `
            CREATE TABLE adventurerStates (
                id INT PRIMARY KEY IDENTITY(1,1),
                adventureId INT NOT NULL,
                partyMemberId INT NOT NULL,
                health INT NOT NULL DEFAULT 100,
                status NVARCHAR(50) DEFAULT 'ACTIVE',
                conditions NVARCHAR(MAX),
                inventory NVARCHAR(MAX),
                lastUpdated DATETIME NOT NULL DEFAULT GETDATE(),
                FOREIGN KEY (adventureId) REFERENCES adventures(id),
                FOREIGN KEY (partyMemberId) REFERENCES partyMembers(id)
            );
        `;
        await sql.query(query);
        console.log('AdventurerStates table created successfully.');
    } catch (error) {
        console.error('Failed to create adventurerStates table:', error);
    }
}

async function createDecisionPointsTable() {
    try {
        await getConnection();
        const query = `
            CREATE TABLE decisionPoints (
                id INT PRIMARY KEY IDENTITY(1,1),
                adventureId INT NOT NULL,
                partyMemberId INT NOT NULL,
                situation NVARCHAR(MAX) NOT NULL,
                choices NVARCHAR(MAX) NOT NULL,
                choiceMade NVARCHAR(MAX),
                consequence NVARCHAR(MAX),
                createdAt DATETIME NOT NULL DEFAULT GETDATE(),
                resolvedAt DATETIME,
                FOREIGN KEY (adventureId) REFERENCES adventures(id),
                FOREIGN KEY (partyMemberId) REFERENCES partyMembers(id)
            );
        `;
        await sql.query(query);
        console.log('DecisionPoints table created successfully.');
    } catch (error) {
        console.error('Failed to create decisionPoints table:', error);
    }
}

async function initDb() {
    try {
        console.log('Starting database initialization...');
        await dropTablesIfExist();
        console.log('Creating users table...');
        await createUsersTable();
        console.log('Creating prompts table...');
        await createPromptsTable();
        console.log('Creating conversations table...');
        await createConversationsTable();
        console.log('Adding foreign key to users table...');
        await addForeignKeyToUsersTable();
        console.log('Creating messages table...');
        await createMessagesTable();
        console.log('Creating parties table...');
        await createPartiesTable();
        console.log('Creating party members table...');
        await createPartyMembersTable();
        console.log('Creating adventures table...');
        await createAdventuresTable();
        console.log('Creating adventurer states table...');
        await createAdventurerStatesTable();
        console.log('Creating decision points table...');
        await createDecisionPointsTable();
        console.log('Database initialization completed successfully!');
    } catch (error) {
        console.error('Database initialization failed:', error);
        process.exit(1); // Exit with error code
    }
}

// Execute initialization
console.log('Starting database initialization script...');
initDb().catch(error => {
    console.error('Fatal error during database initialization:', error);
    process.exit(1);
});

module.exports = {
    initDb
};