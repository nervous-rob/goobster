# Import the config
$config = Get-Content -Path "config.json" | ConvertFrom-Json

# Azure SQL Server connection details
$server = $config.azure.sql.server
$database = $config.azure.sql.database
$username = $config.azure.sql.user
$password = $config.azure.sql.password

# Create connection string
$connectionString = "Server=$server;Database=$database;User Id=$username;Password=$password;Encrypt=True;TrustServerCertificate=False;"

# Query to check tables
$query = @"
-- Check parties table
SELECT TOP 5 * FROM parties ORDER BY id DESC;

-- Check partyMembers table
SELECT TOP 5 * FROM partyMembers ORDER BY id DESC;

-- Check constraints
SELECT 
    OBJECT_NAME(parent_object_id) AS TableName,
    name AS ConstraintName,
    type_desc AS ConstraintType,
    definition AS ConstraintDefinition
FROM sys.check_constraints
WHERE OBJECT_NAME(parent_object_id) IN ('parties', 'partyMembers');

-- Check foreign keys
SELECT 
    OBJECT_NAME(f.parent_object_id) AS TableName,
    f.name AS ForeignKeyName,
    OBJECT_NAME(f.referenced_object_id) AS ReferencedTable,
    COL_NAME(fc.parent_object_id, fc.parent_column_id) AS ColumnName,
    COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS ReferencedColumn
FROM sys.foreign_keys AS f
INNER JOIN sys.foreign_key_columns AS fc ON f.object_id = fc.constraint_object_id
WHERE OBJECT_NAME(f.parent_object_id) IN ('parties', 'partyMembers');
"@

# Execute query using sqlcmd
Write-Host "Querying tables..."
sqlcmd -S $server -d $database -U $username -P $password -Q $query 