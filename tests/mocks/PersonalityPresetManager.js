const mockPersonalityPresetManager = {
    getUserSettings: jest.fn().mockResolvedValue({
        personality_settings: JSON.stringify({
            energy: 'high',
            humor: 'very_high',
            formality: 'low',
            traits: ['friendly', 'casual', 'energetic']
        }),
        personality_preset: 'professional'
    }),
    setUserPreset: jest.fn().mockResolvedValue({
        personality_settings: JSON.stringify({
            energy: 'high',
            humor: 'very_high',
            formality: 'low',
            traits: ['friendly', 'casual', 'energetic', 'internet_culture']
        }),
        personality_preset: 'meme',
        preset: 'meme',
        userId: 'test-user-id'
    }),
    validateSettings: jest.fn().mockImplementation((settings) => {
        if (!settings.energy || !settings.humor || !settings.formality) {
            throw new Error('Invalid settings');
        }
        return true;
    }),
    mixStyles: jest.fn().mockReturnValue({
        energy: 'high',
        humor: 'very_high',
        formality: 'low',
        traits: ['friendly', 'casual', 'energetic']
    }),
    updateUserSettings: jest.fn().mockResolvedValue({
        personality_settings: JSON.stringify({
            energy: 'high',
            humor: 'very_high',
            formality: 'low',
            traits: ['friendly', 'casual', 'energetic']
        }),
        personality_preset: 'professional'
    })
}; 