require('dotenv').config();
const { checkFileSystem } = require('./utils/health-check');
const processor = require('./core/processor');
const logger = require('./utils/logger');

(async () => {
    try {
        // بررسی سلامت سیستم فایل
        const healthCheck = checkFileSystem();
        logger.info('Health check results:', healthCheck);

        if (!healthCheck.linksFile.valid) {
            throw new Error('Invalid links file format');
        }

        if (!healthCheck.outputDir.writable) {
            throw new Error('Output directory is not writable');
        }

        logger.info('Starting crawler...');
        await processor.processLinks();
        logger.info('Crawling completed successfully');
    } catch (error) {
        logger.error('Crawling failed:', error);
        process.exit(1);
    }
})();