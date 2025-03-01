# Database Migrations

This directory contains database migration scripts for Goobster.

## Available Migrations

### Add Personality Directive Column

**Filename:** `add_personality_directive_column.js`  
**Description:** Adds the `personality_directive` column to the `guild_settings` table.

This migration adds support for the personality directives feature, which allows server administrators to customize Goobster's personality on a per-server basis.

## How to Run Migrations

### Windows

Run the batch file:

```
scripts\run_migration.bat
```

### Linux/Mac

Make the shell script executable first:

```bash
chmod +x scripts/run_migration.sh
```

Then run it:

```bash
./scripts/run_migration.sh
```

### Manual Execution

You can also run any migration script directly:

```bash
node scripts/migrations/add_personality_directive_column.js
```

## Migration Script Structure

Each migration script follows a similar pattern:

1. Check if the required changes already exist
2. Use transactions for data integrity
3. Apply the necessary changes
4. Provide detailed logging and error handling

## Creating New Migrations

When creating a new migration script:

1. Create a descriptive filename
2. Include checks to make the script idempotent (safe to run multiple times)
3. Use transactions when making multiple related changes
4. Add proper error handling and logging
5. Make it executable both directly and as a module 