# Adventure Mode User Guide

## Overview
Adventure mode allows users to embark on text-based adventures either solo or with a party. Each adventure features a rich, persistent narrative with tracked story elements, dynamic decision-based gameplay, and meaningful progression toward clear objectives.

## Story Elements

### Theme and Setting
Each adventure has:
- A unique theme that sets the tone
- Specific geographical setting
- Time period or era
- Cultural elements

### Plot Structure
Adventures track:
- Overall plot summary
- 3-5 major plot points to encounter
- Key characters and factions
- Important items and artifacts
- Main antagonist or opposing force

### Win Conditions
Clear objectives including:
- Primary mission objective
- Optional secondary objectives
- Failure conditions to avoid
- Required items or states for victory

### Story State Tracking
The system maintains:
- Current location details
- Time and weather progression
- Active threats and opportunities
- Recent event history
- Environmental conditions
- Story elements encountered

## Commands

### 1. Starting an Adventure
```
/createparty name:"[character name]" backstory:"[optional backstory]"
```
- Creates a new party with you as the first member
- You'll receive a Party ID that others can use to join
- Example: `/createparty name:"Thorin" backstory:"A dwarf warrior seeking glory"`

### 2. Joining an Existing Party
```
/joinparty partyid:[ID] name:"[character name]" backstory:"[optional backstory]"
```
- Joins an existing party using the Party ID
- Maximum 6 players per party
- Example: `/joinparty partyid:123 name:"Gandalf" backstory:"A wise wizard"`

### 3. Beginning the Adventure
```
/startadventure partyid:[ID]
```
- Starts the adventure for the party
- Generates a rich narrative environment with:
  - Unique theme and setting
  - Complex plot structure
  - Clear objectives
  - Initial situation
- Example: `/startadventure partyid:123`

### 4. Making Decisions
```
/makedecision partyid:[ID] choice:[number]
```
- Choose an option when it's your turn
- Each decision:
  - Advances the plot
  - May involve key story elements
  - Affects party members' states
  - Progresses toward objectives
- Example: `/makedecision partyid:123 choice:2`

### 5. Checking Party Status
```
/partystatus partyid:[ID]
```
Shows comprehensive status including:
- Adventure progress
- Plot advancement
- Party member states
- Current situation
- Story elements encountered
- Progress toward objectives
Example: `/partystatus partyid:123`

## Adventure Flow

1. **Story Setup**
   - Rich theme and setting established
   - Major plot points defined
   - Key elements introduced
   - Win conditions set

2. **Decision Making**
   - Each choice advances the story
   - Decisions affect:
     - Plot progression
     - Character states
     - Story element interactions
     - Environmental conditions

3. **Progress Tracking**
   - Plot advancement
   - Objective completion
   - Story element encounters
   - Character development

4. **Victory Conditions**
   - Primary objective tracking
   - Secondary goals monitoring
   - Failure condition checking
   - Required element verification

## Tips for Success

1. **Story Engagement**
   - Pay attention to plot points
   - Track key story elements
   - Remember win conditions
   - Note environmental changes

2. **Decision Making**
   - Consider plot implications
   - Use story elements
   - Track objective progress
   - Mind failure conditions

3. **Party Coordination**
   - Share story information
   - Coordinate on objectives
   - Track collective progress
   - Pool resources

## Status Indicators

### Adventure Progress
- 📖 Plot Points Encountered
- 🎯 Objectives Progress
- ⚠️ Failure Risks
- 🗺️ Story Elements Found

### Character Status
- ⚔️ ACTIVE: Fully functional
- 🤕 INJURED: Reduced capabilities
- 💫 INCAPACITATED: Cannot act
- ☠️ DEAD: Permanently out

### Information Icons
- ❤️ Health
- 📊 Status
- 🔮 Conditions
- 🎒 Inventory

## Example Adventure Session

1. **Adventure Start**
```
/startadventure partyid:123
> Generates rich narrative environment
> Establishes plot and objectives
```

2. **Story Progress**
```
/makedecision partyid:123 choice:2
> Advances plot
> Updates character states
> Tracks story elements
```

3. **Status Check**
```
/partystatus partyid:123
> Shows progress toward objectives
> Lists encountered story elements
> Displays current situation
```

## Limitations

- Maximum 6 players per party
- Cannot join ongoing adventures
- Cannot change character name after joining
- Dead characters remain in party but cannot act
- Cannot restart adventure once begun