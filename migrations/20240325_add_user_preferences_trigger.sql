-- Create trigger for updating user_preferences
CREATE TRIGGER TR_user_preferences_update
ON user_preferences
AFTER UPDATE
AS
BEGIN
    UPDATE user_preferences
    SET updatedAt = GETUTCDATE()
    FROM user_preferences u
    INNER JOIN inserted i ON u.id = i.id;
END; 