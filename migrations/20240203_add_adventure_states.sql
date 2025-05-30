-- Create adventureStates table for tracking ongoing adventures
CREATE TABLE adventureStates (
    id INT PRIMARY KEY IDENTITY(1,1),
    adventureId INT NOT NULL,
    currentScene NVARCHAR(MAX) NOT NULL,
    status NVARCHAR(50) NOT NULL DEFAULT 'active',
    history NVARCHAR(MAX) NOT NULL DEFAULT '[]',
    eventHistory NVARCHAR(MAX) NOT NULL DEFAULT '[]',
    metadata NVARCHAR(MAX) NOT NULL,
    progress NVARCHAR(MAX) NOT NULL,
    environment NVARCHAR(MAX) NOT NULL,
    flags NVARCHAR(MAX) NOT NULL DEFAULT '{}',
    variables NVARCHAR(MAX) NOT NULL DEFAULT '{}',
    createdAt DATETIME NOT NULL DEFAULT GETDATE(),
    lastUpdated DATETIME NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (adventureId) REFERENCES adventures(id)
);

-- Add status check constraint
ALTER TABLE adventureStates ADD CONSTRAINT CHK_adventure_state_status 
    CHECK (status IN ('active', 'paused', 'completed', 'failed'));

-- Create index for performance
CREATE INDEX IX_adventureStates_status ON adventureStates(status);
CREATE INDEX IX_adventureStates_adventureId ON adventureStates(adventureId);

GO
