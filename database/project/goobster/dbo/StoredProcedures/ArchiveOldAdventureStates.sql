
-- 6. Create archiving stored procedure
CREATE   PROCEDURE [dbo].[ArchiveOldAdventureStates]
    @daysOld INT = 30,
    @batchSize INT = 1000
AS
BEGIN
    SET NOCOUNT ON;
    
    DECLARE @cutoffDate DATETIME = DATEADD(DAY, -@daysOld, GETDATE());
    
    BEGIN TRANSACTION;
    
    BEGIN TRY
        -- Archive completed or failed adventures older than cutoff
        INSERT INTO [dbo].[adventureStates_Archive]
        SELECT TOP (@batchSize)
            [id], [adventureId], [currentScene], [status],
            [history], [eventHistory], [metadata], [progress],
            [environment], [flags], [variables], [createdAt],
            [lastUpdated], GETDATE() as [archivedAt]
        FROM [dbo].[adventureStates] WITH (HOLDLOCK)
        WHERE [status] IN ('completed', 'failed')
        AND [lastUpdated] < @cutoffDate;
        
        -- Delete archived records
        DELETE s
        FROM [dbo].[adventureStates] s
        INNER JOIN [dbo].[adventureStates_Archive] a ON s.id = a.id;
        
        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;
        
        THROW;
    END CATCH;
END;
GO

