-- Add adventureId column to parties table
ALTER TABLE parties
ADD adventureId INT NULL;

-- Add foreign key constraint
ALTER TABLE parties
ADD CONSTRAINT FK_Parties_Adventures
FOREIGN KEY (adventureId) REFERENCES adventures(id);

-- Add index for better query performance
CREATE INDEX IX_Parties_AdventureId ON parties(adventureId);

-- Update existing parties to have NULL adventureId
UPDATE parties SET adventureId = NULL WHERE adventureId IS NULL; 