# Changelog

## [1.1.0] - 2025-01-31

### Added
- Perplexity AI Integration
  - Added web search capabilities with Perplexity AI
  - Added `/search` command with detailed response options
  - Added Perplexity API configuration

- Enhanced Audio System
  - Added dynamic background music system with fade transitions
  - Added voice recognition and transcription with Azure Speech Services
  - Added text-to-speech capabilities with multiple voice options
  - Added ambient sound effects with configurable types
  - Added audio mixing service for narration with background music
  - Added volume control and music regeneration features
  - Added voice activity detection with configurable thresholds
  - Added automatic session management and cleanup
  - Added support for multiple concurrent voice sessions
  - Added enhanced error recovery for audio processing
  - Added detailed logging and monitoring

- Voice Commands
  - Added `/transcribe` command for voice-to-text with thread support
  - Added `/speak` command for text-to-speech with mood-based voices
  - Added `/playmusic` and `/stopmusic` commands with mood selection
  - Added `/playambience` and `/stopambience` commands
  - Added `/regeneratemusic` and `/generateallmusic` commands
  - Added voice session management with proper cleanup
  - Added automatic thread creation for transcriptions
  - Added support for custom voice actions

- Audio Processing Features
  - Added proper audio format conversion (48kHz stereo to 16kHz mono)
  - Added enhanced FFmpeg configuration for better audio quality
  - Added backpressure handling in audio pipeline
  - Added proper WAV format processing
  - Added dynamic silence detection
  - Added audio buffering and processing optimization

- Testing Infrastructure
  - Added Jest test configuration
  - Added integration tests for voice features
  - Added unit tests for rate limiting
  - Added mock setup for audio services
  - Added performance testing suite
  - Added voice and audio specific test cases
  - Added session management testing

### Changed
- Updated project architecture to support audio features
- Enhanced configuration management with better organization
- Improved error handling and logging system
- Updated deployment process with Docker support
- Enhanced session management for voice features
- Improved documentation structure and organization
- Modified audio processing pipeline for better performance
- Updated voice recognition flow with better silence handling
- Enhanced connection stability with Discord.js
- Improved resource cleanup procedures
- Updated thread management for voice features

### Fixed
- Fixed voice recognition and transcription issues
  - Resolved audio format mismatch
  - Fixed silence detection parameters
  - Improved recognition accuracy
  - Enhanced error recovery
- Fixed audio pipeline backpressure issues
- Fixed connection handling during disconnects
- Fixed resource cleanup in error scenarios
- Fixed handling of concurrent TTS requests
- Fixed thread creation and management edge cases
- Fixed session cleanup and resource management
- Fixed audio format conversion issues
- Fixed recognition retry logic
- Fixed proper cleanup of voice resources
- Fixed audio stream subscription handling

### Security
- Enhanced API key management
- Improved rate limiting implementation
- Added proper permission checks
- Enhanced resource protection
- Improved session security
- Added better error handling for sensitive operations

### Performance
- Optimized audio processing pipeline
- Improved memory management
- Enhanced connection stability
- Reduced latency in voice recognition
- Improved resource utilization
- Enhanced caching system

## [1.1.1] - 2025-02-01

### Changed
- Improved message chunking system
  - Increased maximum chunk size from 1500 to 1900 characters
  - Reduced aggressive splitting behavior
  - Better preservation of message formatting and structure
  - Improved handling of paragraphs and sections
  - More natural text flow in chunked messages
  - Centralized chunking function to avoid conflicts

- Enhanced search result formatting
  - Added proper Discord markdown conversion
  - Improved header formatting with bold and underline
  - Better list formatting with bullet points
  - Enhanced code block handling
  - Cleaner link formatting with clickable URLs
  - Better section separation and spacing
  - Improved readability of search results

### Fixed
- Fixed overly aggressive message chunking causing unnecessary splits
- Fixed markdown formatting issues in search results
- Fixed inconsistent formatting between user and AI searches
- Fixed link display format for better Discord compatibility
- Fixed duplicate chunkMessage function definition causing startup errors

## [Unreleased]

### Added
- Enhanced voice session management with proper tracking and cleanup
  - Added `isUserInSession`, `addVoiceSession`, and `removeVoiceSession` functions
  - Added session start time tracking
  - Added prevention of multiple concurrent sessions per user
  - Added per-user audio buffer management
  - Added per-user processing state tracking
  - Added per-user silence timing tracking
  - Added proper initialization order for voice sessions
  - Added synchronous state setup before pipeline connection
  - Added proper audio buffer processing after silence detection
  - Added enhanced logging for audio processing events
  - Added verification of successful audio writes to push stream
  - Added comprehensive speech recognition event logging
  - Added detailed recognition state tracking
  - Added recognition session lifecycle monitoring
  - Added speech start/end detection logging
  - Added comprehensive session state verification
  - Added pre-start session cleanup
  - Added automatic retry logic for recognition errors
  - Added enhanced resource cleanup procedures
  - Added race condition prevention in session management
  - Added detailed session state logging
  - Added recovery procedures for failed recognition
  - Added interim results feedback for speech recognition
  - Added specific error handling for different Azure Speech Service errors
  - Added automatic recognizer recreation after errors
  - Added enhanced speech detection sensitivity settings
  - Added NoMatch result handling for better error feedback
  - Added comprehensive audio pipeline monitoring
  - Added packet count tracking for audio streams
  - Added backpressure detection and handling
  - Added detailed error tracking for each pipeline stage
  - Added connection state change monitoring
  - Added automatic connection recovery for Discord.js issues

- Improved audio processing pipeline
  - Added backpressure handling in PCM transformer
  - Added enhanced FFmpeg configuration with better audio filters
  - Added proper silence detection with configurable thresholds
  - Added minimum voice duration requirements (300ms)
  - Added maximum silence duration handling (800ms)
  - Added peak detection in audio analysis
  - Added detailed audio pipeline logging at each stage
  - Added proper WAV header validation
  - Added consecutive silent packet tracking
  - Added automatic pipeline pause after extended silence
  - Added minimum packet size filtering (20 bytes)
  - Added audio buffering for complete utterances
  - Added automatic text-to-speech response handling
  - Added enhanced silence detection events (silenceDetected, maxSilenceReached, audioComplete)
  - Added proper audio segment processing with Azure Speech Services
  - Added dynamic silence thresholds based on audio levels
  - Added state tracking for audio processing
  - Added improved audio buffering logic
  - Added proper audio buffer processing on silence detection
  - Added automatic recognizer restart after processing
  - Added enhanced error recovery for audio processing
  - Added delayed audio pipeline initialization until after recognition starts
  - Added proper scoping of audio buffers and processing states
  - Added user-specific audio state management
  - Added sequential pipeline initialization
  - Added event handler setup before stream connection
  - Added recognition startup verification
  - Added WAV format validation before streaming
  - Added audio format compatibility checks
  - Added recognition session state verification

- Enhanced Text-to-Speech (TTS) functionality
  - Added queue management for TTS requests per channel
  - Added connection reuse and state management
  - Added enhanced SSML configuration with speech pauses
  - Added proper cleanup of event listeners
  - Added metadata to audio resources
  - Added volume normalization
  - Added proper chat integration for voice responses

- New `/transcribe` command for voice-to-text transcription
  - Added private thread creation for transcription output
  - Added toggle functionality to start/stop transcription
  - Added user-specific transcription sessions
  - Added automatic voice channel detection and joining
  - Added permission checking for voice channels
  - Added proper cleanup on transcription stop

- New TranscriptionService for handling speech-to-text
  - Added continuous speech recognition using Azure Speech Services
  - Added proper audio pipeline for Discord voice to Azure Speech
  - Added session management for multiple users
  - Added automatic cleanup of resources
  - Added connection state monitoring
  - Added proper audio format conversion (48kHz stereo to 16kHz mono)

- Added dedicated AudioProcessor service for handling Discord to Azure audio conversion
  - Proper WAV header generation
  - Correct sample rate conversion (48kHz -> 16kHz)
  - Proper channel conversion (stereo -> mono)
  - Backpressure handling
  - Resource cleanup

- Improved audio processing pipeline with proper WAV format

### Changed
- Increased silence detection threshold for better accuracy
- Improved FFmpeg audio filter chain with:
  - Enhanced noise filtering
  - Dynamic audio normalization
  - Better silence detection parameters (0.3s detection window, -30dB threshold)
- Updated voice connection handling with proper state management
- Improved error handling and recovery mechanisms
- Enhanced logging for better debugging
- Modified silence detection to use dynamic thresholds based on peak values
- Updated audio chunk processing to handle odd-length chunks
- Improved pipeline error handling with detailed logging
- Changed silence detection behavior to ignore small packets
- Modified error handling to treat corrupt audio as silence
- Updated logging to only show significant audio events
- Improved audio buffering and processing logic
- Enhanced voice recognition flow with proper silence handling
- Updated audio pipeline to properly handle voice segments
- Adjusted silence thresholds for better voice detection
- Modified voice command to properly integrate with chat system
- Updated audio processing state management
- Improved silence detection event handling
- Enhanced audio buffer processing workflow
- Updated recognizer state management for better reliability
- Modified audio pipeline initialization to wait for recognition session
- Improved audio buffer management with proper scoping
- Enhanced state tracking with per-user management
- Updated silence detection to use user-specific timing
- Reordered pipeline initialization sequence
- Modified event handler setup timing
- Updated stream connection order
- Enhanced silence detection to properly process accumulated audio
- Improved recognition restart timing after silence detection
- Updated audio buffer processing to verify successful writes
- Adjusted speech recognition timeouts for better Discord compatibility
- Enhanced speech detection sensitivity for better accuracy
- Improved error handling with specific error type responses
- Updated TTS response format to include user context
- Enhanced voice connection stability with Discord.js fixes
- Improved audio pipeline monitoring and error handling
- Updated connection state management for better reliability
- Separated speech-to-text functionality from main voice service
- Improved audio processing pipeline with better format conversion
- Enhanced thread management for voice features

### Fixed
- Fixed potential memory leaks in voice sessions
- Fixed audio pipeline backpressure issues
- Fixed connection handling during disconnects
- Fixed cleanup of resources when stopping voice sessions
- Fixed handling of concurrent TTS requests
- Fixed missing audio data by adding proper error handling in silence detection
- Fixed pipeline connection issues between Discord and Azure Speech Services
- Fixed audio format conversion issues
- Fixed resource cleanup in error scenarios
- Fixed event listener memory leaks
- Fixed continuous processing of silent audio packets
- Fixed processing of corrupt or invalid audio chunks
- Fixed silence detection not properly triggering audio processing
- Fixed voice recognition not completing on silence
- Fixed audio buffering and processing timing issues
- Fixed voice command integration with chat system
- Fixed silence detection thresholds being too high
- Fixed audio processing state management issues
- Fixed audio buffer not being processed on silence detection
- Fixed recognizer not restarting after processing
- Fixed incomplete audio segments being processed
- Fixed premature audio processing before recognition starts
- Fixed audioBuffer scope issues
- Fixed processing state tracking across sessions
- Fixed silence timing issues between sessions
- Fixed event handler timing issues
- Fixed pipeline initialization order
- Fixed recognition startup race conditions
- Fixed audio buffer processing after silence detection
- Fixed recognition restart timing
- Fixed push stream write verification
- Fixed speech recognition event handling
- Fixed recognition session state management
- Fixed WAV format validation issues
- Fixed audio format compatibility issues
- Fixed potential race conditions in session management
- Fixed resource cleanup in error scenarios
- Fixed session state inconsistencies
- Fixed recognition retry logic
- Fixed error recovery procedures
- Fixed AudioConfig import missing from voice service
- Fixed recognizer reference being lost during cleanup
- Fixed premature recognizer deletion during session cleanup
- Fixed race condition in recognizer setup and start sequence
- Fixed duplicate session creation causing errors
- Fixed recognizer disposal error during cleanup
- Fixed session cleanup not handling existing sessions properly
- Fixed potential memory leaks in transcription sessions
- Fixed audio format conversion issues between Discord and Azure Speech
- Fixed thread creation and management edge cases
- Fixed proper cleanup of voice resources when stopping transcription
- Fixed thread creation error in transcribe command by using correct thread type value
- Added proper channel type checking for thread creation
- Added better error handling for thread creation failures
- Added permissions verification for thread operations
- Added null checks for thread cache access
- Fixed audio stream subscription to target specific user
- Fixed audio format configuration for Azure Speech Service
- Fixed missing recognition event handlers
- Fixed audio buffering and processing pipeline
- Fixed continuous recognition setup
- Added proper error handling for audio processing
- Fixed missing AudioInputStream import causing transcription failure
- Fixed audio stream format initialization
- Added proper connection ready check
- Improved audio pipeline setup with backpressure handling
- Added session recovery mechanism
- Enhanced error handling and logging
- Fixed PCM stream processing
- Fixed backpressure handling for Azure Speech Service push stream
- Improved audio processing pipeline flow control
- Added timeout-based backpressure management
- Fixed stream event handling compatibility issues
- Voice recognition and transcription not working
  - Fixed audio format mismatch by changing FFmpeg output to raw PCM format
  - Removed unnecessary WAV header handling and buffering in audio processing
  - Adjusted Azure Speech Service configuration for better recognition
  - Improved audio pipeline setup with proper error handling
  - Added enhanced logging for troubleshooting
  - Fixed audio stream subscription setup
  - Optimized silence detection and audio processing
  - Reduced initial silence timeout to prevent delayed recognition
  - Added proper backpressure handling in audio pipeline
  - Improved error recovery in recognition service
- Fixed voice transcription error by removing invalid event listener from Azure push stream
- Fixed error handling in voice service to properly handle Azure Speech SDK stream limitations

### Debug
- Added comprehensive logging throughout the audio pipeline
- Added detailed error reporting for Azure Speech Services
- Added audio analysis metrics logging
- Added connection state logging
- Added pipeline performance monitoring
- Added silence detection event logging
- Added packet size monitoring
- Added audio buffer size tracking
- Added voice activity detection logging
- Added audio processing state logging
- Added improved audio analysis logging
- Added state transition logging
- Added audio buffer processing logging
- Added recognizer state change logging
- Added recognition session lifecycle logging
- Added per-user state tracking logging
- Added audio buffer management logging
- Added pipeline initialization sequence logging
- Added event handler setup logging
- Added stream connection order logging
- Added session state verification logging
- Added cleanup procedure logging
- Added recognition retry logging
- Added error recovery logging
- Added detailed logging for transcription service
- Added connection state logging for voice channels
- Added recognition event logging
- Added session management logging

## [1.0.0] - YYYY-MM-DD
Initial release of Goobster bot 