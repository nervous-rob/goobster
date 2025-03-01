/**
 * Sharp Mock Module
 * This is a mock implementation of the sharp module to allow deployment without native dependencies
 */

function sharp(input) {
    console.log(`[MOCK] Sharp processing input: ${typeof input === 'string' ? input : 'Buffer/Stream'}`);
    
    const mockSharp = {
        resize: (width, height, options) => {
            console.log(`[MOCK] Resizing image to ${width}x${height} with options:`, options || {});
            return mockSharp;
        },
        
        extend: (options) => {
            console.log(`[MOCK] Extending image with options:`, options || {});
            return mockSharp;
        },
        
        composite: (composites) => {
            console.log(`[MOCK] Compositing ${composites?.length || 0} layers`);
            return mockSharp;
        },
        
        toFile: async (outputPath) => {
            console.log(`[MOCK] Saving image to file: ${outputPath}`);
            return { width: 800, height: 600, format: 'png' };
        },
        
        toBuffer: async () => {
            console.log(`[MOCK] Converting image to buffer`);
            return Buffer.from('Mock image data');
        },
        
        jpeg: (options) => {
            console.log(`[MOCK] Converting to JPEG with options:`, options || {});
            return mockSharp;
        },
        
        png: (options) => {
            console.log(`[MOCK] Converting to PNG with options:`, options || {});
            return mockSharp;
        },
        
        webp: (options) => {
            console.log(`[MOCK] Converting to WebP with options:`, options || {});
            return mockSharp;
        }
    };
    
    return mockSharp;
}

module.exports = sharp; 