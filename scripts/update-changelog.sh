#!/bin/bash

echo "Running changelog generator..."
node "$(dirname "$0")/rebuild-changelog.js"

if [ $? -ne 0 ]; then
  echo "Error running changelog generator."
  exit 1
fi

echo "Changelog updated successfully."
echo ""
echo "You can now review the changes and commit them:"
echo "git add changelog.md"
echo "git commit -m \"docs: update changelog\""
echo "git push" 