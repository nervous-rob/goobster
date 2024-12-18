# Adventure Mode User Guide

## Overview
Adventure mode allows users to embark on text-based adventures either solo or with a party. Each adventure is dynamically generated and features decision-based gameplay where your choices affect the story's outcome.

## Commands

### 1. Starting an Adventure
```
/startadventure name:"[character name]" backstory:"[optional backstory]"
```
- Creates a new party with you as the first member
- You'll receive a Party ID that others can use to join
- Example: `/startadventure name:"Thorin" backstory:"A dwarf warrior seeking glory"`

### 2. Joining an Existing Party
```
/joinparty partyid:[ID] name:"[character name]" backstory:"[optional backstory]"
```
- Joins an existing party using the Party ID
- Maximum 6 players per party
- Example: `/joinparty partyid:123 name:"Gandalf" backstory:"A wise wizard"`

### 3. Beginning the Adventure
```
/beginadventure partyid:[ID]
```
- Starts the adventure for the party
- Generates a unique plot, theme, and win condition
- Can be started with any number of players (1-6)
- Example: `/beginadventure partyid:123`

### 4. Making Decisions
```
/makedecision partyid:[ID] choice:[number]
```
- Choose an option when it's your turn
- Numbers correspond to available choices
- Example: `/makedecision partyid:123 choice:2`

### 5. Checking Party Status
```
/partystatus partyid:[ID]
```
- Shows current party information:
  - Adventure progress
  - Party member status
  - Current situation
  - Available choices
- Example: `/partystatus partyid:123`

## Adventure Flow

1. **Party Formation**
   - One player creates the party
   - Others can join (optional)
   - Party leader starts the adventure when ready

2. **Adventure Structure**
   - Each player takes turns making decisions
   - Decisions affect:
     - Character status
     - Story progression
     - Party inventory
     - Environmental conditions

3. **Character States**
   - Health (0-100)
   - Status (Active, Injured, Incapacitated, Dead)
   - Inventory items
   - Special conditions

4. **Turn Order**
   - Round-robin by default
   - Skips incapacitated/dead players
   - Continues until win condition is met

5. **Adventure Completion**
   - Achieved when win condition is met
   - Party status changes to "COMPLETED"
   - Final status report shows achievements

## Tips for Success

1. **Character Creation**
   - Choose distinctive character names
   - Add backstories for richer roleplay
   - Consider party balance when joining

2. **Decision Making**
   - Read the situation carefully
   - Consider party member status
   - Check inventory and conditions
   - Think about long-term consequences

3. **Party Coordination**
   - Communicate with party members
   - Plan strategies together
   - Support injured party members
   - Share resources when possible

## Status Indicators

### Party Status
- 🎭 RECRUITING: Accepting new members
- ⚔️ IN_PROGRESS: Adventure ongoing
- 🎉 COMPLETED: Adventure finished
- ☠️ FAILED: Adventure failed

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

## Error Messages

Common error messages and their meanings:
- "Party is full": Maximum 6 players reached
- "Not your turn": Wait for other players
- "Party not found": Check Party ID
- "Adventure has already begun": Cannot join ongoing adventure
- "Need to register first": Use /register command

## Example Adventure Session

1. **Creating Party**
```
/startadventure name:"Aragorn" backstory:"A ranger from the North"
> Party ID: 123 created!
```

2. **Others Join**
```
/joinparty partyid:123 name:"Legolas" backstory:"An elven archer"
> Joined party successfully!
```

3. **Start Adventure**
```
/beginadventure partyid:123
> Adventure begins with plot and initial situation
```

4. **Making Decisions**
```
/makedecision partyid:123 choice:2
> Action resolved, next player's turn
```

5. **Checking Status**
```
/partystatus partyid:123
> Shows current party state and progress
```

## Limitations

- Maximum 6 players per party
- Cannot join ongoing adventures
- Cannot change character name after joining
- Dead characters remain in party but cannot act
- Cannot restart adventure once begun 