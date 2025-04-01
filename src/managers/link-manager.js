const fs = require('fs');
const path = require('path');
const { FILES } = require('../config/constants');
const logger = require('../utils/logger');

class LinkManager {
    constructor() {
        this.filePath = path.join(__dirname, '../../', FILES.LINKS);
        this.ensureFileExists();
    }

    ensureFileExists() {
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, '[]');
            logger.info('Created new links file');
        }
    }

    getAllLinks() {
        try {
            const data = fs.readFileSync(this.filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            logger.error('Error reading links file:', error);
            return [];
        }
    }

    addLinks(newLinks) {
        const currentLinks = this.getAllLinks();
        const uniqueLinks = [...new Set([...currentLinks, ...newLinks])];

        fs.writeFileSync(this.filePath, JSON.stringify(uniqueLinks, null, 2));
        return uniqueLinks;
    }
}

// Export به صورت کلاس
module.exports = LinkManager;