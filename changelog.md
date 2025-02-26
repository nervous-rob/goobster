# Changelog

## 2025-02-25

### Added
- Merge pull request #10 from nervous-rob/feature/improved-thread-handling
- Merge pull request #9 from nervous-rob/feature/improved-thread-handling

### Documentation
- Update changelog with recent improvements and feature enhancements

### Other
- Improve search functionality with current date context and better approval flow

## 2025-02-07

### Added
- Update database DDL to match existing functionality

### Maintenance
- remove Debug folders from Git tracking

## 2025-02-06

### Added
- Implement Meme Mode feature with dynamic system prompts
- Add Express server startup and logging
- Add OIDC permissions to GitHub Actions workflow
- Add health check and container app configuration
- Add Azure Login step to GitHub Actions workflow
- Add dev environment configuration to GitHub Actions workflow

### Changed
- Update container app configuration
- Update container app deployment with dynamic image tagging
- Update Azure login secrets in GitHub Actions workflow
- Update GitHub Actions workflow with Azure AD token exchange audience
- Update GitHub Actions workflow with DISCORD_GUILD_IDS validation and configuration

### Other
- Improve config.json generation with jq formatting
- Refactor GitHub Actions workflow to generate config.json directly

### Removed
- Remove hardcoded config.json generation from Dockerfile
- Remove unnecessary OIDC permissions from GitHub Actions workflow

## 2025-02-05

### Added
- Add documentation comment for Dockerfile config generation

### Changed
- Modify Dockerfile config generation to use direct envsubst output

### Documentation
- Refactor Dockerfile config generation with improved multi-line JSON formatting
- Refactor Dockerfile config generation using envsubst for dynamic configuration
- Refactor Dockerfile config generation using printf with improved variable handling
- Enhance Dockerfile config generation with improved JSON formatting and jq validation

### Removed
- Simplify Dockerfile config generation by removing template and envsubst

## 2025-02-03

### Added
- new dockerfile
- Add configuration management and GitHub Actions workflow
- new dockerfile

### Changed
- update
- update gitignore
- Update .gitignore to exclude data directories

### Documentation
- Improve Dockerfile config generation with enhanced JSON formatting and validation
- Simplify Dockerfile config generation using envsubst
- Refactor Dockerfile config generation using printf for improved readability and flexibility
- Enhance Dockerfile with dynamic configuration and improved file handling

### Fixed
- fix docker build

### Other
- Merge branch 'main' of https://github.com/nervous-rob/goobster
- Refactor adventure commands with service-based architecture and improved error handling
- Merge pull request #8 from nervous-rob/improvement/adventure-service
- Merge pull request #7 from nervous-rob/improvement/adventure-service
- Merge pull request #6 from nervous-rob/improvement/adventure-service
- Merge pull request #5 from nervous-rob/improvement/adventure-service
- Enhance database and adventure system with robust resource management and state handling
- Create an auto-deploy file
- app-icon
- Refactor adventure service with comprehensive modular architecture

### Removed
- Remove .cursor directory and .cursorrules from git tracking (moved to .gitignore)
- Remove data/music from git tracking (moved to .gitignore)

## 2025-02-02

### Added
- add gitignore
- Merge pull request #4 from nervous-rob/feature/voice-mode
- Add comprehensive TODO tracking and system improvement documentation

### Changed
- Update .gitignore to exclude cursor rules files

### Other
- Implement advanced VoiceDetectionManager with robust audio activity tracking

## 2025-02-01

### Other
- Enhance message chunking and search result formatting system
- Implement comprehensive AI search and interaction system

## 2025-01-31

### Added
- Implement comprehensive audio system with advanced features and improvements
- Add comprehensive audio system documentation for Goobster
- Add default ambient and music audio files for enhanced atmosphere
- Add comprehensive voice and audio services with advanced features

## 2025-01-19

### Added
- Merge pull request #3 from nervous-rob/feature/adventure-mode
- Refactor and enhance Goobster bot with new features and improvements

## 2025-01-03

### Other
- Enhance adventure gameplay with improved prompts and decision-making structure

## 2024-12-19

### Changed
- Enhance adventure gameplay with image generation and database updates

## 2024-12-18

### Added
- Update chat commands to use new model version "gpt-4o" for OpenAI completions

### Changed
- Update documentation to GPT-4o

### Documentation
- Enhance adventure gameplay structure and documentation

### Fixed
- Add debug logging functionality to adventure commands

### Other
- Enhance adventure gameplay with structured prompts and state management
- Refactor deploy commands to support multiple guilds

## 2024-12-17

### Added
- Add adventure commands: Implement `startAdventure`, `joinParty`, `beginAdventure`, `makeDecision`, `partyStatus` commands for managing adventure parties and gameplay. Integrate OpenAI for adventure generation and decision-making, enhancing user interaction and engagement in the Discord bot. Includes error handling and database transactions for robust functionality.
- Implement adventure mode database schema: add tables for parties, party members, adventures, adventurer states, and decision points. Update initDb.js to include new table creation and drop existing tables if they exist. Enhance documentation with a detailed schema overview for better understanding of the new features.
- Add Azure and Discord setup guides to documentation
- Add comprehensive documentation for Goobster Discord bot, including system architecture, command usage, configuration setup, database schema, and development guidelines. This enhances clarity for developers and users, ensuring proper understanding of the bot's functionality and setup requirements.
- Refactor ping command to improve database connection handling and response timing. Added immediate reply deferment to prevent timeouts, enhanced error messages, and ensured proper connection checks before querying the database.

### Changed
- Refactor chat message handling to use EmbedBuilder instead of MessageEmbed. This change updates the Discord.js integration for better compatibility with the latest library version.

### Other
- Refactor adventure commands and enhance database connection handling
- Enhance adventure commands with party size validation and game state management

## 2024-04-16

### Changed
- Update README.md

## 2024-03-18

### Other
- Merge pull request #2 from nervous-rob/UserManagement

## 2024-03-17

### Added
- Adding new commands for chat and utility

## 2024-02-23

### Added
- adding db-init command to package.json
- Adding sql to GetConnection
- Update initDB with new columns and tables

### Other
- Chat command creation

## 2024-02-22

### Added
- Adding /createuser
- Adding database init script

### Changed
- Update ping command to check DB connectivity

### Other
- Merge pull request #1 from nervous-rob/main

## 2024-02-21

### Added
- Added mssql

## 2024-02-16

### Added
- Add deploy-commands and start scripts to package.json
- Add new commands and deploy them
- Add config.json to .gitignore

### Changed
- Update installation and configuration instructions
- Update Dockerfile and README.md

## 2024-02-15

### Other
- Initial commit

