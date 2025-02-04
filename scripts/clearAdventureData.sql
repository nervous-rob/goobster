-- Clear all adventure-related data in the correct order
-- First, disable all foreign key constraints
ALTER TABLE resourceAllocations NOCHECK CONSTRAINT ALL;
ALTER TABLE decisionPoints NOCHECK CONSTRAINT ALL;
ALTER TABLE adventureImages NOCHECK CONSTRAINT ALL;
ALTER TABLE adventurerStates NOCHECK CONSTRAINT ALL;
ALTER TABLE adventureStates NOCHECK CONSTRAINT ALL;
ALTER TABLE partyAdventures NOCHECK CONSTRAINT ALL;
ALTER TABLE adventures NOCHECK CONSTRAINT ALL;
ALTER TABLE partyMembers NOCHECK CONSTRAINT ALL;
ALTER TABLE parties NOCHECK CONSTRAINT ALL;

BEGIN TRY
    BEGIN TRANSACTION;

    -- Delete from child tables first (those with foreign keys)
    DELETE FROM resourceAllocations;
    DELETE FROM decisionPoints;
    DELETE FROM adventureImages;
    DELETE FROM adventurerStates;
    DELETE FROM adventureStates;
    DELETE FROM partyAdventures;
    
    -- Then delete from parent tables
    DELETE FROM adventures;
    DELETE FROM partyMembers;
    
    -- Update parties to RECRUITING status instead of deleting
    UPDATE parties SET 
        adventureStatus = 'RECRUITING',
        isActive = 1,
        lastUpdated = GETDATE();

    -- Reset identity columns
    DBCC CHECKIDENT ('resourceAllocations', RESEED, 0);
    DBCC CHECKIDENT ('decisionPoints', RESEED, 0);
    DBCC CHECKIDENT ('adventureImages', RESEED, 0);
    DBCC CHECKIDENT ('adventurerStates', RESEED, 0);
    DBCC CHECKIDENT ('adventureStates', RESEED, 0);
    DBCC CHECKIDENT ('adventures', RESEED, 0);
    DBCC CHECKIDENT ('partyMembers', RESEED, 0);
    DBCC CHECKIDENT ('parties', RESEED, 0);

    COMMIT TRANSACTION;

    PRINT 'All adventure data has been cleared and IDs reset. Parties have been reset to RECRUITING status.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRANSACTION;
    
    PRINT 'Error occurred while clearing data:';
    PRINT ERROR_MESSAGE();
END CATCH

-- Re-enable all foreign key constraints
ALTER TABLE resourceAllocations CHECK CONSTRAINT ALL;
ALTER TABLE decisionPoints CHECK CONSTRAINT ALL;
ALTER TABLE adventureImages CHECK CONSTRAINT ALL;
ALTER TABLE adventurerStates CHECK CONSTRAINT ALL;
ALTER TABLE adventureStates CHECK CONSTRAINT ALL;
ALTER TABLE partyAdventures CHECK CONSTRAINT ALL;
ALTER TABLE adventures CHECK CONSTRAINT ALL;
ALTER TABLE partyMembers CHECK CONSTRAINT ALL;
ALTER TABLE parties CHECK CONSTRAINT ALL; 