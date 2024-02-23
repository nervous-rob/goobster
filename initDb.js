const { sql, getConnection } = require('./azureDb');
const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
});

async function createUsersTable() {
    try {
        await getConnection(); // Ensure connection to the database
        const tableExists = await sql.query`SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'users'`;
        if (tableExists.recordset.length > 0) {
            readline.question('Users table already exists. Do you want to drop and recreate it? (yes/no) ', async (answer) => {
                if (answer.toLowerCase() === 'yes') {
                    await sql.query`DROP TABLE users`;
                    await createTable();
                    readline.close();
                } else {
                    console.log('Operation cancelled.');
                    readline.close();
                }
            });
        } else {
            await createTable();
        }
    } catch (error) {
        console.error('Failed to create users table:', error);
    }
}

async function createTable() {
    const query = `
        CREATE TABLE users (
            id INT PRIMARY KEY IDENTITY(1,1),
            username NVARCHAR(50) NOT NULL,
            joinedAt DATETIME NOT NULL DEFAULT GETDATE()
        );
    `;
    await sql.query(query);
    console.log('Users table created successfully.');
}

createUsersTable();