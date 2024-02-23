const { sql, getConnection } = require('./azureDb');

async function dropTablesIfExist() {
    try {
        await getConnection();
        const query = `
            IF OBJECT_ID('messages', 'U') IS NOT NULL 
                DROP TABLE messages;
            IF OBJECT_ID('conversations', 'U') IS NOT NULL 
                DROP TABLE conversations;
            IF OBJECT_ID('prompts', 'U') IS NOT NULL 
                DROP TABLE prompts;
            IF OBJECT_ID('users', 'U') IS NOT NULL 
                DROP TABLE users;
        `;
        await sql.query(query);
        console.log('Tables dropped successfully if they existed.');
    } catch (error) {
        console.error('Failed to drop tables:', error);
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

async function initDb() {
    await dropTablesIfExist();
    await createUsersTable();
    await createPromptsTable();
    await createConversationsTable();
    await addForeignKeyToUsersTable();
    await createMessagesTable();
}

initDb();