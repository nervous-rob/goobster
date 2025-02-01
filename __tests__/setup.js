// Import required test utilities
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// Mock FFmpeg for audio processing tests
jest.mock('prism-media', () => ({
    opus: {
        Decoder: jest.fn().mockImplementation(() => ({
            on: jest.fn(),
            destroy: jest.fn()
        }))
    },
    FFmpeg: jest.fn().mockImplementation(() => ({
        on: jest.fn(),
        destroy: jest.fn()
    }))
}));

// Mock Azure Speech SDK
jest.mock('microsoft-cognitiveservices-speech-sdk', () => ({
    AudioConfig: {
        fromStreamInput: jest.fn().mockReturnValue({})
    },
    AudioInputStream: {
        createPushStream: jest.fn().mockReturnValue({
            write: jest.fn().mockReturnValue(true),
            close: jest.fn()
        })
    },
    AudioStreamFormat: {
        getWaveFormatPCM: jest.fn().mockReturnValue({})
    },
    SpeechConfig: {
        fromSubscription: jest.fn().mockReturnValue({
            speechRecognitionLanguage: 'en-US',
            setProperty: jest.fn(),
            setServiceProperty: jest.fn(),
            outputFormat: null,
            speechSynthesisVoiceName: null
        })
    },
    SpeechRecognizer: jest.fn().mockImplementation(() => ({
        recognizing: jest.fn(),
        recognized: jest.fn(),
        startContinuousRecognitionAsync: jest.fn().mockResolvedValue(undefined),
        stopContinuousRecognitionAsync: jest.fn().mockResolvedValue(undefined),
        close: jest.fn()
    })),
    OutputFormat: {
        Raw16Khz16BitMonoPcm: 'Raw16Khz16BitMonoPcm',
        Raw8Khz8BitMonoPcm: 'Raw8Khz8BitMonoPcm',
        Riff16Khz16BitMonoPcm: 'Riff16Khz16BitMonoPcm',
        Riff8Khz8BitMonoPcm: 'Riff8Khz8BitMonoPcm'
    },
    ResultReason: {
        RecognizedSpeech: 'RecognizedSpeech',
        NoMatch: 'NoMatch',
        Canceled: 'Canceled'
    },
    CancellationReason: {
        Error: 'Error',
        EndOfStream: 'EndOfStream'
    }
}));

// Silence console logs during tests
global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};

// Clear all mocks before each test
beforeEach(() => {
    jest.clearAllMocks();
}); 