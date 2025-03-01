#!/bin/bash
echo "Running personality directive column migration..."
node scripts/migrations/add_personality_directive_column.js
if [ $? -eq 0 ]; then
    echo "Migration completed successfully!"
else
    echo "Migration failed with error code $?"
    exit $?
fi 