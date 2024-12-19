# Adventure Mode Database Schema

## Overview
The adventure mode feature extends the database schema to support text-based adventures with multiple participants, party management, and dynamic storytelling.

## Tables

### parties
Manages adventure parties and their current state.
```sql
CREATE TABLE parties (
    id INT PRIMARY KEY IDENTITY(1,1),
    createdAt DATETIME NOT NULL DEFAULT GETDATE(),
    isActive BIT NOT NULL DEFAULT 1,
    adventureStatus VARCHAR(20) DEFAULT 'RECRUITING'
)
```
- `id`: Unique identifier for each party
- `createdAt`: Timestamp of party creation
- `isActive`: Whether the party is still active
- `adventureStatus`: Current party status (RECRUITING, IN_PROGRESS, COMPLETED)

### partyMembers
Links users to parties and stores their adventurer details.
```sql
CREATE TABLE partyMembers (
    id INT PRIMARY KEY IDENTITY(1,1),
    partyId INT NOT NULL,
    userId INT NOT NULL,
    adventurerName NVARCHAR(50) NOT NULL,
    backstory NVARCHAR(MAX),
    joinedAt DATETIME NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (partyId) REFERENCES parties(id),
    FOREIGN KEY (userId) REFERENCES users(id)
)
```
- `id`: Unique identifier for each party member
- `partyId`: Reference to the party
- `userId`: Reference to the user
- `adventurerName`: Character name in the adventure
- `backstory`: Optional character backstory
- `joinedAt`: Timestamp of when they joined

### adventures
Stores adventure details and progress.
```sql
CREATE TABLE adventures (
    id INT PRIMARY KEY IDENTITY(1,1),
    partyId INT NOT NULL,
    theme NVARCHAR(100) NOT NULL,
    setting NVARCHAR(MAX) NOT NULL,          -- JSON: {geography, era, culture}
    plotSummary NVARCHAR(MAX) NOT NULL,
    plotPoints NVARCHAR(MAX) NOT NULL,       -- JSON array of major plot points
    keyElements NVARCHAR(MAX) NOT NULL,      -- JSON: {characters, items, antagonist}
    winCondition NVARCHAR(MAX) NOT NULL,     -- JSON: {primary, secondary[], failureConditions[], requiredElements[]}
    currentState NVARCHAR(MAX),              -- JSON: Complex state object
    startedAt DATETIME NOT NULL DEFAULT GETDATE(),
    completedAt DATETIME,
    FOREIGN KEY (partyId) REFERENCES parties(id)
)
```
- `id`: Unique identifier for each adventure
- `partyId`: Reference to the adventuring party
- `theme`: Adventure theme/setting (max 100 chars)
- `setting`: Detailed setting information in JSON format
- `plotSummary`: Brief plot overview
- `plotPoints`: Array of major plot points that must be encountered
- `keyElements`: Important story elements to track
- `winCondition`: Structured win conditions and requirements
- `currentState`: Current adventure state including:
  - Location details
  - Time and weather
  - Active threats and opportunities
  - Recent events
  - Environmental effects
- `startedAt`: Adventure start timestamp
- `completedAt`: Adventure completion timestamp

### adventurerStates
Tracks the current state of each party member during an adventure.
```sql
CREATE TABLE adventurerStates (
    id INT PRIMARY KEY IDENTITY(1,1),
    adventureId INT NOT NULL,
    partyMemberId INT NOT NULL,
    health INT NOT NULL DEFAULT 100,
    status NVARCHAR(50) DEFAULT 'ACTIVE',
    conditions NVARCHAR(MAX),
    inventory NVARCHAR(MAX),
    lastUpdated DATETIME NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (adventureId) REFERENCES adventures(id),
    FOREIGN KEY (partyMemberId) REFERENCES partyMembers(id)
)
```
- `id`: Unique identifier for each state record
- `adventureId`: Reference to the adventure
- `partyMemberId`: Reference to the party member
- `health`: Current health points
- `status`: Current status (ACTIVE, INJURED, INCAPACITATED, etc.)
- `conditions`: Active conditions/effects
- `inventory`: Current inventory items
- `lastUpdated`: Last state update timestamp

### adventureImages
Stores generated images for adventure elements.
```sql
CREATE TABLE adventureImages (
    id INT PRIMARY KEY IDENTITY(1,1),
    adventureId INT NOT NULL,
    imageType NVARCHAR(50) NOT NULL, -- CHARACTER, LOCATION, ITEM, SCENE
    referenceKey NVARCHAR(100) NOT NULL, -- e.g. characterName, locationName, itemName
    imageUrl NVARCHAR(MAX) NOT NULL,
    styleParameters NVARCHAR(MAX), -- JSON string of style parameters used
    generatedAt DATETIME NOT NULL DEFAULT GETDATE(),
    FOREIGN KEY (adventureId) REFERENCES adventures(id)
)
```

The `styleParameters` field stores the parameters used to generate the image, ensuring consistency when generating related images later. This includes art style, color palette, and other relevant parameters.

### decisionPoints
Records adventure decisions and their consequences.
```sql
CREATE TABLE decisionPoints (
    id INT PRIMARY KEY IDENTITY(1,1),
    adventureId INT NOT NULL,
    partyMemberId INT NOT NULL,
    situation NVARCHAR(MAX) NOT NULL,
    choices NVARCHAR(MAX) NOT NULL,          -- JSON array of choices
    choiceMade NVARCHAR(MAX),
    consequence NVARCHAR(MAX),               -- JSON: {description, plotProgress, keyElementsUsed}
    plotProgress NVARCHAR(MAX),              -- JSON: Story progression details
    keyElementsUsed NVARCHAR(MAX),           -- JSON array of story elements used
    createdAt DATETIME NOT NULL DEFAULT GETDATE(),
    resolvedAt DATETIME,
    FOREIGN KEY (adventureId) REFERENCES adventures(id),
    FOREIGN KEY (partyMemberId) REFERENCES partyMembers(id)
)
```
- `id`: Unique identifier for each decision point
- `adventureId`: Reference to the adventure
- `partyMemberId`: Party member making the decision
- `situation`: Current scenario description
- `choices`: Available choices
- `choiceMade`: Selected choice
- `consequence`: Structured outcome including:
  - Detailed description
  - Plot progression
  - Story elements used
- `plotProgress`: How the decision advanced the story
- `keyElementsUsed`: Story elements referenced in this decision
- `createdAt`: Decision point creation timestamp
- `resolvedAt`: Decision resolution timestamp

## Relationships

1. **Party to PartyMembers** (1:Many)
   - One party can have multiple party members
   - Each party member belongs to one party

2. **Party to Adventure** (1:1)
   - One party has one active adventure
   - Each adventure belongs to one party

3. **Adventure to AdventurerStates** (1:Many)
   - One adventure has multiple adventurer states
   - Each state belongs to one adventure

4. **Adventure to DecisionPoints** (1:Many)
   - One adventure has multiple decision points
   - Each decision point belongs to one adventure 