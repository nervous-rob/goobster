-- Drop existing foreign key constraints
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(parent_object_id))
    + '.' + QUOTENAME(OBJECT_NAME(parent_object_id)) 
    + ' DROP CONSTRAINT ' + QUOTENAME(name) + ';'
FROM sys.foreign_keys
WHERE referenced_object_id = OBJECT_ID('parties')
   OR referenced_object_id = OBJECT_ID('adventures')
   OR referenced_object_id = OBJECT_ID('partyMembers');
EXEC sp_executesql @sql;
GO

-- Drop existing tables
DROP TABLE IF EXISTS decisionPoints;
DROP TABLE IF EXISTS adventureImages;
DROP TABLE IF EXISTS adventurerStates;
DROP TABLE IF EXISTS partyMembers;
DROP TABLE IF EXISTS adventures;
DROP TABLE IF EXISTS parties;
GO

-- Create updated tables
CREATE TABLE parties (
    id INT PRIMARY KEY IDENTITY(1,1),
    leaderId NVARCHAR(255) NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT GETDATE(),
    isActive BIT NOT NULL DEFAULT 1,
    adventureStatus VARCHAR(20) DEFAULT 'RECRUITING',
    settings NVARCHAR(MAX) NOT NULL DEFAULT '{"maxSize": 4}',
    lastUpdated DATETIME NOT NULL DEFAULT GETDATE()
);

CREATE TABLE partyMembers (
    id INT PRIMARY KEY IDENTITY(1,1),
    partyId INT NOT NULL,
    userId NVARCHAR(255) NOT NULL,
    adventurerName NVARCHAR(100) NOT NULL,
    backstory NVARCHAR(MAX),
    memberType NVARCHAR(50) NOT NULL DEFAULT 'member',
    joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
    lastUpdated DATETIME NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (partyId) REFERENCES parties(id)
);

CREATE TABLE adventures (
    id INT PRIMARY KEY IDENTITY(1,1),
    title NVARCHAR(100) NOT NULL,
    description NVARCHAR(MAX),
    createdBy NVARCHAR(255) NOT NULL,
    settings NVARCHAR(MAX) NOT NULL,
    theme NVARCHAR(100),
    setting NVARCHAR(MAX) NOT NULL,
    plotSummary NVARCHAR(MAX) NOT NULL,
    plotPoints NVARCHAR(MAX) NOT NULL,
    keyElements NVARCHAR(MAX) NOT NULL,
    winCondition NVARCHAR(MAX) NOT NULL,
    currentState NVARCHAR(MAX),
    status NVARCHAR(50) NOT NULL DEFAULT 'initialized',
    metadata NVARCHAR(MAX),
    startedAt DATETIME NOT NULL DEFAULT GETDATE(),
    completedAt DATETIME,
    lastUpdated DATETIME NOT NULL DEFAULT GETDATE()
);

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

CREATE TABLE adventureImages (
    id INT PRIMARY KEY IDENTITY(1,1),
    adventureId INT NOT NULL,
    imageType NVARCHAR(50) NOT NULL,
    referenceKey NVARCHAR(100) NOT NULL,
    imageUrl NVARCHAR(MAX) NOT NULL,
    styleParameters NVARCHAR(MAX),
    generatedAt DATETIME NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (adventureId) REFERENCES adventures(id)
);

CREATE TABLE decisionPoints (
    id INT PRIMARY KEY IDENTITY(1,1),
    adventureId INT NOT NULL,
    partyMemberId INT NOT NULL,
    situation NVARCHAR(MAX) NOT NULL,
    choices NVARCHAR(MAX) NOT NULL,
    choiceMade NVARCHAR(MAX),
    consequence NVARCHAR(MAX),
    plotProgress NVARCHAR(MAX),
    keyElementsUsed NVARCHAR(MAX),
    createdAt DATETIME NOT NULL DEFAULT GETDATE(),
    resolvedAt DATETIME,
    FOREIGN KEY (adventureId) REFERENCES adventures(id),
    FOREIGN KEY (partyMemberId) REFERENCES partyMembers(id)
);

-- Create junction table for party-adventure relationship
CREATE TABLE partyAdventures (
    partyId INT NOT NULL,
    adventureId INT NOT NULL,
    joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
    PRIMARY KEY (partyId, adventureId),
    FOREIGN KEY (partyId) REFERENCES parties(id),
    FOREIGN KEY (adventureId) REFERENCES adventures(id)
);

-- Create resource allocations table
CREATE TABLE resourceAllocations (
    id INT PRIMARY KEY IDENTITY(1,1),
    adventureId INT NOT NULL,
    resourceType NVARCHAR(50) NOT NULL,
    limits NVARCHAR(MAX) NOT NULL,
    used INT NOT NULL DEFAULT 0,
    lastReset DATETIME NOT NULL DEFAULT GETDATE(),
    resetInterval INT NOT NULL,
    FOREIGN KEY (adventureId) REFERENCES adventures(id)
);

-- Create indexes for performance
CREATE INDEX IX_parties_status ON parties(adventureStatus);
CREATE INDEX IX_adventures_status ON adventures(status);
CREATE INDEX IX_adventures_createdBy ON adventures(createdBy);
CREATE INDEX IX_partyMembers_userId ON partyMembers(userId);
CREATE INDEX IX_adventurerStates_status ON adventurerStates(status);
CREATE INDEX IX_decisionPoints_resolvedAt ON decisionPoints(resolvedAt);
CREATE INDEX IX_resourceAllocations_type ON resourceAllocations(resourceType);

-- Add constraints for data integrity
ALTER TABLE adventures ADD CONSTRAINT CHK_adventure_status 
    CHECK (status IN ('initialized', 'active', 'completed', 'failed'));

ALTER TABLE parties ADD CONSTRAINT CHK_party_status 
    CHECK (adventureStatus IN ('RECRUITING', 'ACTIVE', 'COMPLETED', 'DISBANDED'));

ALTER TABLE adventurerStates ADD CONSTRAINT CHK_adventurer_status 
    CHECK (status IN ('ACTIVE', 'INJURED', 'INCAPACITATED', 'DEAD'));

ALTER TABLE resourceAllocations ADD CONSTRAINT CHK_resource_type
    CHECK (resourceType IN ('tokens', 'images', 'api_calls'));

-- Add unique constraint to prevent duplicate party memberships
ALTER TABLE partyMembers ADD CONSTRAINT UQ_party_member 
    UNIQUE (partyId, userId);

-- Add constraints for data integrity
ALTER TABLE partyMembers ADD CONSTRAINT CHK_member_type 
    CHECK (memberType IN ('leader', 'member', 'guest'));

GO 