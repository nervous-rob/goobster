@echo off
echo Running personality directive column migration...
node scripts/migrations/add_personality_directive_column.js
if %ERRORLEVEL% == 0 (
    echo Migration completed successfully!
) else (
    echo Migration failed with error code %ERRORLEVEL%
    exit /b %ERRORLEVEL%
) 