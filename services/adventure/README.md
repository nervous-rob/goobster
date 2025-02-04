# Adventure Service

## Overview
The Adventure Service manages interactive text-based adventures with dynamic storytelling, party management, and state tracking. Each adventure features:
- Rich, persistent narrative with tracked story elements
- Dynamic decision-based gameplay
- Meaningful progression toward clear objectives
- Solo or party-based gameplay options
- Real-time voice narration and ambient audio

## Core Components

### Models

#### Adventure Model
```javascript
// Core adventure structure
const adventure = new Adventure({
  id: 'generated-uuid',
  title: 'Epic Quest',
  description: 'A grand journey begins...',
  createdBy: userId,
  settings: {
    maxPartySize: 4,
    difficulty: 'normal',
    genre: 'fantasy',
    complexity: 'medium'
  },
  state: {
    status: 'initialized',
    currentScene: {
      title: 'Adventure Beginning',
      description: 'Your adventure is about to begin...',
      choices: [],
      location: {
        place: 'Starting Point',
        surroundings: 'A place of new beginnings',
        weather: 'clear',
        timeOfDay: 'morning'
      }
    },
    history: [],
    startedAt: timestamp,
    lastUpdated: timestamp
  }
});
```

#### Party Model
```javascript
// Party configuration
const party = new Party({
  id: 'generated-uuid',
  leaderId: userId,
  leaderName: 'Thorin',
  leaderBackstory: 'A dwarf warrior',
  settings: {
    maxSize: 4,
    defaultRole: 'member',
    leaderRole: 'leader'
  },
  status: 'RECRUITING',
  isActive: true
});

// Party capabilities
party.addMember({
  userId: memberId,
  adventurerName: 'Gimli',
  backstory: 'Skilled axe-wielder',
  role: 'member'
});

party.canStartAdventure();  // Checks readiness
party.getReadinessMessage();  // Gets status explanation
party.isMember(userId);  // Checks membership
party.isLeader(userId);  // Checks leadership
```

#### Scene Model
```javascript
// Scene structure
const scene = new Scene({
  id: 'generated-uuid',
  adventureId: adventureId,
  title: 'The Dark Cave',
  description: 'A foreboding entrance looms before you...',
  choices: [{
    id: 'choice-uuid',
    text: 'Enter the cave cautiously',
    consequences: ['Potential ambush', 'May find treasure'],
    requirements: ['torch', 'courage'],
    metadata: { type: 'exploration' }
  }],
  state: {
    status: 'active',
    selectedChoice: null
  },
  metadata: {
    type: 'standard',
    difficulty: 'normal',
    atmosphere: 'tense'
  }
});

// Scene operations
scene.addChoice({
  text: 'Search for another entrance',
  consequences: ['Time consuming', 'Might be safer'],
  requirements: ['perception']
});

scene.selectChoice('choice-id');  // Resolves a choice
scene.isChoiceValid('choice-id');  // Validates requirements
```

#### Model Features

##### Adventure Model Features
- Full state management
- Party member tracking
- Scene history logging
- Progress tracking
- Automatic timestamps
- JSON serialization

##### Party Model Features
- Role-based permissions
- Size limit enforcement
- Member management
- Status tracking
- Activity monitoring
- Readiness validation

##### Scene Model Features
- UUID generation
- Choice management
- Requirement validation
- State tracking
- Metadata handling
- Transaction support

### Generators

#### Adventure Generator
```javascript
class AdventureGenerator {
  // Default settings
  defaultSettings = {
    maxPartySize: 4,
    difficulty: 'normal',
    genre: 'fantasy',
    complexity: 'medium',
    aiModel: 'gpt-4o'
  };

  // Generate new adventure
  async generateAdventure({ createdBy, theme, difficulty, settings = {} }) {
    // Generate adventure content using OpenAI
    const content = await this._generateAdventureContent({
      theme,
      difficulty: settings.difficulty || this.defaultSettings.difficulty
    });

    // Create adventure instance
    const adventure = new Adventure({
      title: content.title,
      description: content.description,
      createdBy,
      settings: {
        ...this.defaultSettings,
        ...settings
      }
    });

    // Generate initial scene
    const initialScene = await this._generateInitialScene(
      adventure.id,
      content.initialScenePrompt
    );
    adventure.updateScene(initialScene);

    return adventure;
  }

  // Private methods for content generation
  async _generateAdventureContent({ theme, difficulty });
  async _generateInitialScene(adventureId, scenePrompt);
}
```

#### Decision Generator
```javascript
class DecisionGenerator {
  // Default settings
  defaultSettings = {
    aiModel: 'gpt-4o',
    temperature: 0.7,
    considerPartySize: true,
    considerPreviousChoices: true
  };

  // Process player decisions
  async processDecision({ scene, choice, party, history }) {
    const consequences = await this._generateConsequences({
      scene, choice, party, history
    });
    const impact = this._analyzeDecisionImpact(consequences);
    return { consequences, impact, timestamp: new Date() };
  }
}
```

#### Scene Generator
```javascript
class SceneGenerator {
  // Default settings
  defaultSettings = {
    minChoices: 2,
    maxChoices: 4,
    aiModel: 'gpt-4o',
    imageModel: 'dall-e-3',
    imageSize: '1024x1024',
    imageStyle: 'vivid'
  };

  // Scene generation
  async generateNextScene({
    adventureId,
    previousScene,
    chosenAction,
    adventureContext
  }) {
    const scene = await this._generateSceneContent({
      type: 'next',
      previousScene,
      chosenAction,
      context: adventureContext
    });

    return new Scene({
      adventureId,
      title: scene.title,
      description: scene.description,
      choices: scene.choices,
      metadata: scene.metadata
    });
  }
}
```

#### Generator Features

##### Adventure Generation
- Theme-based content creation
- Dynamic difficulty scaling
- Initial scene setup
- Party size consideration
- Setting customization

##### Decision Processing
- Context-aware consequences
- Impact analysis
- Party size consideration
- Historical context
- Requirement validation

##### Scene Generation
- Dynamic scene creation
- Image generation
- Special scene types
- Environment details
- Choice generation
- Resource management

### Repositories

#### Base Repository
```javascript
// Common database operations
class BaseRepository {
  // Core operations with transaction support
  async findById(transaction, id);
  async findAll(transaction, condition, params);
  async create(transaction, model);
  async update(transaction, id, model);
  async delete(transaction, id);
  
  // Transaction management
  async beginTransaction();
  async executeQuery(transaction, query, params);
  
  // Type handling
  _getSqlType(value);  // Auto-detects SQL types
  _toModel(row);       // Converts DB row to model
  _fromModel(model);   // Converts model to DB row
}
```

#### Adventure Repository
```javascript
// Adventure-specific operations
class AdventureRepository extends BaseRepository {
  async create(transaction, adventure) {
    // Creates adventure with full data model
    return await this.executeQuery(transaction, `
      INSERT INTO adventures (
        title, description, createdBy, settings, theme,
        setting, plotSummary, plotPoints, keyElements,
        winCondition, currentState, status, metadata
      ) VALUES (@title, @description, ...);
    `, adventure);
  }
  
  // Specialized queries
  async findActiveByUser(transaction, userId);
  async findByParty(transaction, partyId);
  async updateState(transaction, adventureId, state);
  async complete(transaction, adventureId, summary);
}
```

#### Party Repository
```javascript
// Party management operations
class PartyRepository extends BaseRepository {
  // Core party operations
  async create(transaction, partyData);
  async addMember(transaction, partyId, member);
  async getWithMembers(transaction, partyId);
  async removeMember(transaction, partyId, userId);
  
  // Specialized queries
  async findByMember(transaction, userId);
  async findByAdventure(transaction, adventureId);
  async updateProgress(transaction, partyId, type, data);
  async updateMemberDetails(transaction, partyId, userId, updates);
}
```

#### Resource Repository
```javascript
// Resource allocation tracking
class ResourceRepository extends BaseRepository {
  // Resource management
  async initializeResources(transaction, adventureId, settings);
  async requestAllocation(transaction, adventureId, resourceType, amount);
  async releaseAllocation(transaction, adventureId, resourceType, amount);
  
  // Resource queries
  async findByType(transaction, adventureId, resourceType);
  async findByAdventure(transaction, adventureId);
  async cleanupResources(transaction, adventureId);
}
```

#### Scene Repository
```javascript
// Scene management
class SceneRepository extends BaseRepository {
  // Scene operations
  async findByAdventure(transaction, adventureId);
  async findActiveScene(transaction, adventureId);
  async getHistory(transaction, adventureId, limit);
  async completeScene(transaction, sceneId, outcome);
  
  // Data conversion
  _toModel(row) {
    return new Scene({
      id: row.id,
      adventureId: row.adventureId,
      title: row.title,
      description: row.description,
      choices: JSON.parse(row.choices),
      state: JSON.parse(row.state),
      metadata: JSON.parse(row.metadata)
    });
  }
}
```

#### State Repository
```javascript
// State persistence
class StateRepository extends BaseRepository {
  // State operations
  async findByAdventure(transaction, adventureId);
  async updateFlags(transaction, adventureId, flags);
  async updateVariables(transaction, adventureId, variables);
  async addEvent(transaction, adventureId, event);
  async updateEnvironment(transaction, adventureId, environment);
  async updateProgress(transaction, adventureId, progress);
  
  // State data model
  _toModel(row) {
    return {
      id: row.id,
      adventureId: row.adventureId,
      currentScene: JSON.parse(row.currentScene),
      status: row.status,
      history: JSON.parse(row.history),
      eventHistory: JSON.parse(row.eventHistory),
      metadata: JSON.parse(row.metadata),
      progress: JSON.parse(row.progress),
      environment: JSON.parse(row.environment),
      flags: JSON.parse(row.flags || '{}'),
      variables: JSON.parse(row.variables || '{}')
    };
  }
}
```

#### Repository Features

##### Transaction Support
- All operations use transactions
- Automatic rollback on errors
- Nested transaction handling
- Connection pooling

##### Data Conversion
- Automatic type detection
- JSON serialization/deserialization
- Model mapping
- Validation checks

##### Error Handling
- Detailed error logging
- Transaction rollback
- Connection retry logic
- Data integrity checks

##### Performance
- Connection pooling
- Prepared statements
- Parameterized queries
- Efficient JSON handling

### Utils

#### Logger
```javascript
// Winston-based logging configuration
const logger = winston.createLogger({
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
  },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // Console output in development
    new winston.transports.Console({
      format: winston.format.colorize()
    }),
    // File output in production
    new winston.transports.File({
      filename: 'logs/adventure-error.log',
      level: 'error'
    }),
    new winston.transports.File({
      filename: 'logs/adventure-combined.log'
    })
  ]
});
```

#### PromptBuilder
```javascript
class PromptBuilder {
  // Template types
  templates = {
    scene: {
      base: `Create a detailed scene with:
        - Title and description
        - Environmental details
        - 2-4 meaningful choices
        - Clear consequences`,
      combat: `Design combat encounter with:
        - Tactical options
        - Environmental factors
        - Risk/reward balance`,
      puzzle: `Create puzzle with:
        - Multiple solutions
        - Embedded hints
        - Clear success/failure`
    },
    character: {
      npc: `Design NPC with:
        - Distinct personality
        - Clear motivations
        - Hidden aspects`
    },
    consequence: {
      base: `Generate consequences considering:
        - Immediate effects
        - Long-term impact
        - Party dynamics
        - World changes`
    }
  };

  // Build prompts for different scenarios
  buildScenePrompt(options);
  buildConsequencePrompt(options);
  buildNPCPrompt(options);
}
```

#### ResponseFormatter
```javascript
class ResponseFormattingService {
  // Format different response types
  formatAdventureStart({ adventure, party, images, initialScene }) {
    return {
      embeds: [{
        title: '🎮 Adventure Begins!',
        description: adventure.theme,
        fields: [
          { name: 'Setting', value: adventure.setting },
          { name: 'Plot', value: adventure.plotSummary },
          { name: 'Objectives', value: adventure.winCondition }
        ],
        image: { url: images.location }
      }]
    };
  }

  formatDecisionResponse({ decision, consequences, nextScene }) {
    return {
      embeds: [{
        title: 'Decision Outcome',
        fields: [
          { name: 'What Happened', value: consequences.narration },
          { name: 'Next Scene', value: nextScene.description },
          { name: 'Available Choices', value: this._formatChoices(nextScene.choices) }
        ]
      }]
    };
  }

  // Helper methods
  _truncateText(text, maxLength);
  _formatChoices(choices);
  _formatImageFiles(images);
}
```

#### ResponseParser
```javascript
class ResponseParser {
  // Schema definitions
  schemas = {
    scene: {
      required: ['title', 'description', 'choices'],
      optional: ['metadata', 'mood']
    },
    consequence: {
      required: ['immediate', 'longTerm', 'partyImpact'],
      optional: ['stateChanges']
    },
    npc: {
      required: ['name', 'description', 'traits'],
      optional: ['secrets', 'motivations']
    }
  };

  // Parse different response types
  parseSceneResponse(response) {
    const parsed = this._parseJSON(response);
    this._validateSchema(parsed, this.schemas.scene);
    return parsed;
  }

  parseConsequenceResponse(response) {
    const parsed = this._parseJSON(response);
    this._validateSchema(parsed, this.schemas.consequence);
    return parsed;
  }

  // Helper methods
  _parseJSON(text);
  _validateSchema(obj, schema);
  _generateId();
}
```

#### VoiceIntegration
```javascript
class VoiceIntegrationService {
  // Default settings
  defaultSettings = {
    musicVolume: 0.3,
    narrationVolume: 1.0,
    connectionTimeout: 30000,
    moodMusicPath: 'data/music'
  };

  // Voice connection management
  async initializeVoiceConnection(channel) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator
    });

    const players = {
      musicPlayer: createAudioPlayer(),
      narrationPlayer: createAudioPlayer()
    };

    return { connection, ...players };
  }

  // Audio playback
  async playBackgroundMusic(channelId, mood) {
    const musicPath = path.join(this.defaultSettings.moodMusicPath, `${mood}.mp3`);
    const musicResource = createAudioResource(musicPath, {
      inputType: 'file',
      inlineVolume: true
    });
    musicResource.volume.setVolume(this.defaultSettings.musicVolume);
    return this.players.get(channelId).musicPlayer.play(musicResource);
  }

  async playNarration(channelId, text) {
    const narrationStream = await this.generateNarration(text);
    const narrationResource = createAudioResource(narrationStream, {
      inputType: 'arbitrary',
      inlineVolume: true
    });
    narrationResource.volume.setVolume(this.defaultSettings.narrationVolume);
    return this.players.get(channelId).narrationPlayer.play(narrationResource);
  }
}
```

### Utility Features

#### Logging System
- Custom log levels and colors
- Environment-based output
- Structured JSON logging
- Automatic timestamp addition
- File rotation in production

#### Prompt Generation
- Template-based system
- Context-aware prompts
- Multiple scenario types
- Dynamic placeholder filling
- Consistent formatting

#### Response Formatting
- Discord-optimized output
- Rich embed generation
- Dynamic field creation
- Image attachment handling
- Message length management

#### Response Parsing
- Schema validation
- JSON structure verification
- Error recovery
- Type conversion
- ID generation

#### Voice System
- Connection management
- Multi-channel audio
- Volume control
- Resource cleanup
- Error handling

### Validators

#### Adventure Validator
```javascript
class AdventureValidator {
  // Valid options
  validDifficulties = ['easy', 'normal', 'hard', 'expert'];
  validStatuses = ['active', 'paused', 'completed', 'failed'];

  // Initialization validation
  validateInitialization({ createdBy, theme, difficulty, settings = {} }) {
    const errors = [];

    if (!createdBy) errors.push('createdBy is required');
    if (difficulty && !this.validDifficulties.includes(difficulty)) {
      errors.push(`difficulty must be one of: ${this.validDifficulties.join(', ')}`);
    }
    if (settings.maxPartySize && (settings.maxPartySize < 1 || settings.maxPartySize > 10)) {
      errors.push('maxPartySize must be between 1 and 10');
    }

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    return true;
  }

  // Decision validation
  validateDecision({ adventureId, userId, decision }) {
    const errors = [];
    if (!adventureId) errors.push('adventureId is required');
    if (!userId) errors.push('userId is required');
    if (!decision) errors.push('decision is required');

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    return true;
  }

  // Special scene validation
  validateSpecialScene({ adventureId, type, context = {} }) {
    const errors = [];
    const validTypes = ['combat', 'puzzle', 'dialogue'];

    if (!adventureId) errors.push('adventureId is required');
    if (!type) errors.push('type is required');
    if (!validTypes.includes(type)) {
      errors.push(`type must be one of: ${validTypes.join(', ')}`);
    }

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    return true;
  }
}
```

#### Party Validator
```javascript
class PartyValidator {
  // Valid options
  validRoles = ['leader', 'member', 'guest'];
  validStatuses = ['active', 'disbanded', 'full'];

  // Party creation validation
  validatePartyCreation({ adventureId, leaderId, settings = {} }) {
    const errors = [];

    if (!adventureId) errors.push('adventureId is required');
    if (!leaderId) errors.push('leaderId is required');
    if (settings.maxSize && (settings.maxSize < 1 || settings.maxSize > 10)) {
      errors.push('maxSize must be between 1 and 10');
    }

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    return true;
  }

  // Member operation validation
  validateMemberOperation({ partyId, userId, role }) {
    const errors = [];

    if (!partyId) errors.push('partyId is required');
    if (!userId) errors.push('userId is required');
    if (role && !this.validRoles.includes(role)) {
      errors.push(`role must be one of: ${this.validRoles.join(', ')}`);
    }

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    return true;
  }

  // Party settings validation
  validatePartySettings({ partyId, settings = {} }) {
    const errors = [];

    if (!partyId) errors.push('partyId is required');
    if (settings.maxSize && (settings.maxSize < 1 || settings.maxSize > 10)) {
      errors.push('maxSize must be between 1 and 10');
    }

    if (errors.length > 0) {
      throw new Error(`Validation failed: ${errors.join(', ')}`);
    }
    return true;
  }
}
```

#### Validation Features

##### Adventure Validation
- Difficulty level checking
- Status transitions
- Party size limits
- Required field validation
- Context validation for special scenes

##### Party Validation
- Role permission checking
- Size limit enforcement
- Member operation validation
- Settings validation
- Status transition checking

##### Common Features
- Detailed error messages
- Multiple error collection
- Type checking
- Range validation
- Enum validation

## Main Service

### Adventure Service
The core service that orchestrates all adventure functionality.

```javascript
class AdventureService {
  constructor() {
    // Core managers
    this.partyManager = new PartyManager();
    this.stateManager = new StateManager();
    this.resourceManager = new ResourceManager();

    // Content generators
    this.adventureGenerator = new AdventureGenerator();
    this.sceneGenerator = new SceneGenerator();
    this.decisionGenerator = new DecisionGenerator();

    // Validators
    this.adventureValidator = new AdventureValidator();
    this.partyValidator = new PartyValidator();

    // Service settings
    this.settings = {
      maxConcurrentAdventures: 100,
      maxPartySize: 4,
      defaultDifficulty: 'normal',
      tokenCostPerScene: 1000,
      imageCostPerScene: 1
    };
  }

  // Core adventure operations
  async initializeAdventure({ createdBy, theme, difficulty, settings = {} }) {
    const transaction = await adventureRepository.beginTransaction();
    try {
      // Generate adventure content
      const adventure = await this.adventureGenerator.generateAdventure({
        createdBy, theme, difficulty, settings
      });

      // Initialize resources and state
      await this.resourceManager.initializeResources({ adventureId: adventure.id });
      await this.stateManager.initializeState({ adventureId: adventure.id });

      // Create initial party
      const party = await this.partyManager.createParty({
        adventureId: adventure.id,
        leaderId: createdBy
      });

      // Generate scene imagery
      const images = await this._generateAdventureImages(adventure, party);

      await transaction.commit();
      return { adventure, party, images };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // Decision processing
  async processDecision({ adventureId, userId, decision, voiceChannel }) {
    const transaction = await adventureRepository.beginTransaction();
    try {
      // Validate and process decision
      const state = await this.stateManager.getState(adventureId);
      const party = await this.partyManager.findPartyByMember(userId);
      
      const result = await this.decisionGenerator.processDecision({
        scene: state.currentScene,
        choice: decision,
        party: party,
        history: state.history
      });

      // Generate next scene
      const nextScene = await this.sceneGenerator.generateNextScene({
        adventureId,
        previousScene: state.currentScene,
        chosenAction: decision,
        adventureContext: result.consequences
      });

      // Handle voice narration if requested
      if (voiceChannel) {
        await voiceIntegrationService.playBackgroundMusic(
          voiceChannel.id,
          result.consequences.atmosphere
        );
        await voiceIntegrationService.playNarration(
          voiceChannel.id,
          result.consequences.narration
        );
      }

      await transaction.commit();
      return { state: nextScene, consequences: result };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
}
```

### Service Features

#### Core Functionality
- Adventure initialization and management
- Party creation and member management
- Scene generation and progression
- Decision processing and consequences
- Resource allocation and tracking
- State management and persistence

#### Integration Points
- Voice channel integration
- Image generation services
- AI content generation
- Database transactions
- Event logging

#### Error Handling
- Transaction management
- Rollback support
- Validation checks
- Resource cleanup
- Error logging

#### Performance Features
- Connection pooling
- Resource caching
- Batch operations
- Efficient state tracking
- Memory management

## Flow Overview

1. **Adventure Creation**
```javascript
const adventure = await adventureService.initializeAdventure({
  createdBy: userId,
  theme: 'fantasy',
  difficulty: 'normal',
  settings: {
    maxPartySize: 4,
    complexity: 'medium',
    genre: 'fantasy'
  }
});
```

2. **Party Management**
```javascript
// Create new party
const party = await partyManager.createParty({
  leaderId: userId,
  adventurerName: 'Thorin',
  backstory: 'A dwarf warrior',
  settings: {
    maxSize: 4,
    defaultRole: 'member',
    leaderRole: 'leader'
  }
});

// Add member to party
await partyManager.addMember({
  partyId: partyId,
  userId: newMemberId,
  adventurerName: 'Gimli',
  backstory: 'Skilled axe-wielder'
});
```

3. **Scene Generation**
```javascript
// Generate next scene
const scene = await sceneGenerator.generateNextScene({
  adventureId: adventureId,
  previousScene: currentScene,
  chosenAction: lastDecision,
  adventureContext: {
    atmosphere: 'tense',
    partySize: party.members.length,
    difficulty: 'normal'
  }
});

// Generate scene imagery
const sceneImage = await sceneGenerator.generateSceneImage(
  adventureId,
  scene.description,
  { style: 'vivid', size: '1024x1024' }
);
```

4. **Decision Processing**
```javascript
const result = await adventureService.processDecision({
  adventureId: adventureId,
  userId: userId,
  decision: choiceId,
  voiceChannel: voiceChannelId  // Optional voice narration
});
```

## State Management

### State Tracking
- **Adventure State**:
  - Current scene and location
  - Time and weather progression
  - Active threats and opportunities
  - Plot points encountered
  - Objectives completed
  - Key elements found
  - Resource usage metrics

### State Operations
```javascript
// Initialize state
await stateManager.initializeState({
  adventureId: adventureId,
  initialState: {
    currentScene: startingScene,
    status: 'active',
    environment: {
      timeOfDay: 'morning',
      weather: 'clear',
      visibility: 'good'
    }
  }
});

// Update state with new scene
await stateManager.updateState({
  adventureId: adventureId,
  updates: {
    currentScene: newScene,
    lastDecision: {
      userId: userId,
      decision: choiceId,
      consequences: results
    }
  }
});
```

### History Management
- Maintains detailed event history (last 50 events)
- Tracks detailed decision history (last 20 decisions)
- Auto-cleanup of old history entries
- Transaction-based history updates

## Resource Management

### Resource Types
- **Tokens**: AI interaction limits
  - Per-interval limits (e.g., 10000/day)
  - Total usage limits (e.g., 100000)
  - Automatic reset intervals

- **Images**: Scene and character visuals
  - Per-interval limits (10/day)
  - Total limit per adventure (50)
  - Quality and size options

- **Special Scenes**: Combat/Puzzle encounters
  - Limited availability (5/day)
  - Total limit per adventure (20)
  - Complexity controls

### Resource Operations
```javascript
// Initialize resources
await resourceManager.initializeResources({
  adventureId: adventureId,
  limits: {
    tokens: {
      maxPerInterval: 10000,
      maxTotal: 100000,
      resetInterval: 24 * 60 * 60 * 1000  // 24 hours
    },
    images: {
      maxPerInterval: 10,
      maxTotal: 50
    },
    specialScenes: {
      maxPerInterval: 5,
      maxTotal: 20
    }
  }
});

// Request resource allocation
const success = await resourceManager.requestAllocation({
  adventureId: adventureId,
  resourceType: 'tokens',
  amount: 1000
});

// Release unused resources
await resourceManager.releaseAllocation({
  adventureId: adventureId,
  resourceType: 'tokens',
  amount: 500
});
```

### Resource Management Features
- Automatic cleanup of unused resources
- Cache-based resource tracking
- Transaction-based allocation
- Usage monitoring and alerts
- Automatic interval resets

## Voice Integration

### Features
- Background music system
- Mood-based audio
- Text-to-speech narration
- Audio mixing and transitions

### Usage Example
```javascript
// Play background music
await voiceService.playBackgroundMusic(channelId, 'battle');

// Narrate scene
await voiceService.playNarration(channelId, sceneText);
```

## Error Handling

### Validation
- Input validation through validators
- State transition validation
- Resource availability checks

### Recovery
- Transaction rollback support
- State recovery mechanisms
- Connection retry logic

## Database Schema

### Core Tables
- adventures
- parties
- scenes
- states
- resources
- members

### Schema Example
```sql
CREATE TABLE adventures (
  id VARCHAR(36) PRIMARY KEY,
  status VARCHAR(20),
  created_by VARCHAR(36),
  settings JSON
);

CREATE TABLE parties (
  id VARCHAR(36) PRIMARY KEY,
  adventure_id VARCHAR(36),
  leader_id VARCHAR(36),
  status VARCHAR(20)
);
```

## Usage Examples

### Starting an Adventure
```javascript
const adventureService = new AdventureService();

// Initialize adventure
const adventure = await adventureService.startAdventure({
  userId: 'user123',
  theme: 'medieval',
  difficulty: 'normal'
});

// Create party
const party = await adventureService.createParty({
  adventureId: adventure.id,
  leaderId: 'user123'
});
```

### Making Decisions
```javascript
// Process player choice
const result = await adventureService.makeDecision({
  adventureId: 'adv123',
  userId: 'user123',
  choiceId: 'choice456'
});

// Handle results
if (result.status === 'success') {
  await messageHandler.sendResponse(result.response);
}
```

## Development Guidelines

1. **Input Validation**
   - Use appropriate validator
   - Check all required fields
   - Validate state transitions

2. **Error Handling**
   - Use try-catch blocks
   - Log errors with context
   - Return user-friendly messages

3. **State Management**
   - Use transactions for state changes
   - Validate state transitions
   - Maintain data consistency

4. **Testing**
   - Unit test core functions
   - Integration test flows
   - Test error scenarios

## Configuration

### Environment Variables
- AZURE_DB_CONNECTION: Database connection string
- AI_SERVICE_KEY: AI service API key
- VOICE_SERVICE_KEY: Voice service API key

### Default Settings
- maxPartySize: 10
- tokenLimit: 1000
- sceneTimeout: 300000

## Monitoring

### Logging
- Error logging
- State transitions
- Resource usage
- Performance metrics

### Health Checks
- Database connectivity
- AI service status
- Voice service status
- Resource availability

## Contributing
1. Follow coding standards
2. Add appropriate tests
3. Update documentation
4. Use feature branches
5. Submit pull requests

## License
MIT License 