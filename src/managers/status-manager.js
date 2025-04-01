const fs = require('fs');
const path = require('path');
const { FILES, STATUS } = require('../config/constants');
const logger = require('../utils/logger');

class StatusManager {
    constructor() {
        this.filePath = path.join(__dirname, '../../', FILES.STATUS);
        this.initialize();
    }

    initialize() {
        if (!fs.existsSync(this.filePath)) {
            this.save({
                meta: {
                    version: '1.0.0',
                    createdAt: new Date().toISOString()
                },
                stats: {
                    total: 0,
                    completed: 0,
                    failed: 0,
                    pending: 0
                },
                links: []
            });
        }
    }

    get() {
        try {
            return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch (error) {
            logger.error('Error reading status file:', error);
            throw error;
        }
    }

    save(data) {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            logger.error('Error saving status file:', error);
            throw error;
        }
    }

    updateLinkStatus(url, status, details = {}) {
        const data = this.get();
        const linkIndex = data.links.findIndex(link => link.url === url);

        const entry = {
            url,
            status,
            updatedAt: new Date().toISOString(),
            ...details
        };

        if (linkIndex >= 0) {
            data.links[linkIndex] = { ...data.links[linkIndex], ...entry };
        } else {
            data.links.push(entry);
            data.stats.total = data.links.length;
        }

        // Update statistics
        data.stats = {
            total: data.links.length,
            completed: data.links.filter(l => l.status === STATUS.COMPLETED).length,
            failed: data.links.filter(l => l.status === STATUS.FAILED).length,
            pending: data.links.filter(l => l.status === STATUS.PENDING).length
        };

        data.meta.lastUpdated = new Date().toISOString();
        this.save(data);
        return entry;
    }

    getPendingLinks() {
        return this.get().links
            .filter(link => link.status === STATUS.PENDING)
            .map(link => link.url);
    }
}

module.exports = StatusManager;