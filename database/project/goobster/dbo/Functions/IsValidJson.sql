-- First, let's create a helper function to safely handle JSON
CREATE   FUNCTION [dbo].[IsValidJson]
(
    @Value NVARCHAR(MAX)
)
RETURNS BIT
AS
BEGIN
    IF (@Value IS NULL) RETURN 0
    IF (ISJSON(@Value) > 0) RETURN 1
    RETURN 0
END;
GO

