/**
 * AWS Utilities Mock
 * This is a mock implementation of AWS utilities to allow deployment without AWS SDK dependencies
 */

const logger = require('../services/adventure/utils/logger');

/**
 * Mock S3 upload function
 * @param {Buffer|string} fileData - File data to upload
 * @param {string} key - The S3 key (path) to upload to
 * @param {Object} options - Upload options
 * @returns {Promise<Object>} Mock S3 upload result
 */
async function s3Upload(fileData, key, options = {}) {
    logger.info(`[MOCK] S3 Upload - Would upload file to: ${key}`, { options });
    
    // Simulate a short delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Return a mock S3 response
    return {
        ETag: `"${Math.random().toString(36).substring(2, 10)}"`,
        Location: `https://mock-s3-bucket.s3.amazonaws.com/${key}`,
        Key: key,
        Bucket: 'mock-s3-bucket'
    };
}

/**
 * Mock S3 download function
 * @param {string} key - The S3 key (path) to download from
 * @returns {Promise<Buffer>} Mock file data
 */
async function s3Download(key) {
    logger.info(`[MOCK] S3 Download - Would download file from: ${key}`);
    
    // Simulate a short delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Return mock data
    return Buffer.from('Mock S3 file data');
}

/**
 * Mock S3 delete function
 * @param {string} key - The S3 key (path) to delete
 * @returns {Promise<Object>} Mock deletion result
 */
async function s3Delete(key) {
    logger.info(`[MOCK] S3 Delete - Would delete file at: ${key}`);
    
    // Simulate a short delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Return mock deletion response
    return {
        DeleteMarker: true,
        VersionId: `${Math.random().toString(36).substring(2, 10)}`,
        RequestCharged: 'requester'
    };
}

module.exports = {
    s3Upload,
    s3Download,
    s3Delete
}; 