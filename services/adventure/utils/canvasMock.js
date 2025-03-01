/**
 * Canvas Mock Module
 * This is a mock implementation of the canvas module to allow deployment without native dependencies
 */

class Canvas {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        console.log(`[MOCK] Canvas created with dimensions ${width}x${height}`);
    }

    getContext(type) {
        console.log(`[MOCK] Getting context of type: ${type}`);
        return {
            drawImage: () => console.log('[MOCK] Drawing image on canvas'),
            fillText: () => console.log('[MOCK] Writing text on canvas'),
            fillRect: () => console.log('[MOCK] Drawing rectangle on canvas'),
            clearRect: () => console.log('[MOCK] Clearing rectangle on canvas'),
            stroke: () => console.log('[MOCK] Stroke operation'),
            fill: () => console.log('[MOCK] Fill operation'),
            beginPath: () => console.log('[MOCK] Beginning path'),
            closePath: () => console.log('[MOCK] Closing path'),
            moveTo: () => console.log('[MOCK] Moving to point'),
            lineTo: () => console.log('[MOCK] Drawing line to point'),
            arc: () => console.log('[MOCK] Drawing arc'),
            save: () => console.log('[MOCK] Saving canvas state'),
            restore: () => console.log('[MOCK] Restoring canvas state'),
        };
    }

    toBuffer() {
        console.log('[MOCK] Converting canvas to buffer');
        return Buffer.from('Mock image data');
    }

    toDataURL() {
        console.log('[MOCK] Converting canvas to data URL');
        return 'data:image/png;base64,MOCK_DATA';
    }
}

const createCanvas = (width, height) => {
    console.log(`[MOCK] Creating canvas with dimensions ${width}x${height}`);
    return new Canvas(width, height);
};

const loadImage = async (src) => {
    console.log(`[MOCK] Loading image from ${src}`);
    return {
        width: 800,
        height: 600,
        src
    };
};

module.exports = {
    createCanvas,
    loadImage,
    Canvas
}; 