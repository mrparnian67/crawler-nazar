const puppeteer = require('puppeteer');
const { BROWSER } = require('../config/constants');
const logger = require('../utils/logger');

class BrowserManager {
    static async launch() {
        try {
            const browser = await puppeteer.launch({
                executablePath: process.env.CHROMIUM_PATH,
                headless: false, // برای دیباگ بهتر false بگذارید
                args: BROWSER.ARGS,
                protocolTimeout: BROWSER.TIMEOUT,
                userDataDir: process.env.CHROMIUM_USER_DATA_DIR
            });
            logger.debug('Browser launched successfully');
            return browser;
        } catch (error) {
            logger.error('Failed to launch browser:', error);
            throw error;
        }
    }

    static async newPage(browser) {
        const page = await browser.newPage();
        await page.setDefaultTimeout(BROWSER.TIMEOUT);
        await page.setViewport({ width: 1920, height: 1080 });

        await page.setRequestInterception(true);
        page.on('request', req => {
            ['image', 'font', 'stylesheet'].includes(req.resourceType())
                ? req.abort()
                : req.continue();
        });

        return page;
    }
}

// Export صحیح کلاس
module.exports = BrowserManager;