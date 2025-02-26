@echo off
echo Running changelog generator...
node %~dp0\rebuild-changelog.js
if %ERRORLEVEL% NEQ 0 (
  echo Error running changelog generator.
  exit /b %ERRORLEVEL%
)
echo Changelog updated successfully.
echo.
echo You can now review the changes and commit them:
echo git add changelog.md
echo git commit -m "docs: update changelog"
echo git push 