const path = require('path');
const fs = require('fs');
const { FILES, SELECTORS, BROWSER } = require('../config/constants');
const BrowserManager = require('./browser');
const logger = require('../utils/logger');
const { sleep, formatDuration } = require('../utils/helpers');

class LinkProcessor {
    constructor() {
        this.maxRetries = parseInt(process.env.MAX_RETRIES) || 3;
        this.concurrency = parseInt(process.env.MAX_CONCURRENCY) || 3;
        this.activeTasks = 0;
        this.taskQueue = [];
        this.ensureOutputDirectory();
    }

    ensureOutputDirectory() {
        const outputDir = path.join(__dirname, '../../', FILES.OUTPUT_DIR);
        try {
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
                logger.info(`Created output directory: ${outputDir}`);
            }
            // Test write permission
            const testFile = path.join(outputDir, `test_${Date.now()}.tmp`);
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
        } catch (err) {
            logger.error('Output directory access error:', err);
            throw err;
        }
    }

    async processLinks() {
        try {
            const links = this.loadLinks();
            if (links.length === 0) {
                logger.warn('No links found to process');
                return { processed: 0, failed: 0 };
            }

            logger.info(`Starting to process ${links.length} links`);
            const results = { processed: 0, failed: 0 };

            for (const url of links) {
                await this.enqueueTask(url, results);
            }

            await this.drainQueue();
            logger.info(`Processing completed. Success: ${results.processed}, Failed: ${results.failed}`);
            return results;
        } catch (error) {
            logger.error('Fatal error in processLinks:', error);
            throw error;
        }
    }

    loadLinks() {
        try {
            const filePath = path.join(__dirname, '../../', FILES.LINKS);
            const data = fs.readFileSync(filePath, 'utf8');
            const links = JSON.parse(data);

            if (!Array.isArray(links)) {
                throw new Error('Links file does not contain valid array');
            }

            return links.slice(0, 5); // فقط 5 لینک برای تست اولیه
        } catch (error) {
            logger.error('Error loading links:', error);
            throw error;
        }
    }

    async enqueueTask(url, results) {
        return new Promise((resolve) => {
            const task = async () => {
                try {
                    const startTime = Date.now();
                    logger.info(`Processing URL: ${url}`);

                    const content = await this.processLinkWithRetry(url);
                    this.saveResult(url, content);

                    results.processed++;
                    logger.info(`Completed ${url} in ${formatDuration(Date.now() - startTime)}`);
                } catch (error) {
                    results.failed++;
                    logger.error(`Failed to process ${url}: ${error.message}`);
                } finally {
                    resolve();
                }
            };

            this.taskQueue.push(task);
            this.runNextTask();
        });
    }

    async runNextTask() {
        while (this.activeTasks < this.concurrency && this.taskQueue.length > 0) {
            this.activeTasks++;
            const task = this.taskQueue.shift();

            task().finally(() => {
                this.activeTasks--;
                this.runNextTask();
            });
        }
    }

    async drainQueue() {
        while (this.activeTasks > 0 || this.taskQueue.length > 0) {
            await sleep(100);
        }
    }

    async processLinkWithRetry(url) {
        let attempt = 0;
        let lastError = null;

        while (attempt < this.maxRetries) {
            attempt++;
            try {
                logger.info(`Attempt ${attempt} for ${url}`);
                const content = await this.attemptProcessing(url);
                return content;
            } catch (error) {
                lastError = error;
                logger.error(`Attempt ${attempt} failed for ${url}:`, {
                    message: error.message,
                    stack: error.stack,
                    url: url
                });

                if (attempt < this.maxRetries) {
                    const delay = 2000 * attempt;
                    logger.info(`Waiting ${delay}ms before next attempt...`);
                    await sleep(delay);
                }
            }
        }

        logger.error(`All attempts failed for ${url}`, {
            error: lastError.message,
            stack: lastError.stack
        });
        throw lastError;
    }

    async attemptProcessing(url) {
        const browser = await BrowserManager.launch();
        const page = await BrowserManager.newPage(browser);
        const debugData = {
            url,
            timestamps: {
                start: new Date().toISOString()
            },
            errors: [],
            screenshots: []
        };

        try {
            // 1. تنظیمات اولیه صفحه
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9'
            });

            // 2. رفتن به URL با مدیریت خطا
            debugData.timestamps.navigationStart = new Date().toISOString();
            try {
                await page.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: 60000
                });
            } catch (navError) {
                debugData.errors.push({
                    type: 'NAVIGATION_ERROR',
                    message: navError.message,
                    timestamp: new Date().toISOString()
                });
                throw navError;
            }
            debugData.timestamps.navigationEnd = new Date().toISOString();

            // 3. گرفتن اسکرین‌شات برای دیباگ
            const screenshotPath = `debug/${Date.now()}_page.png`;
            await page.screenshot({ path: screenshotPath, fullPage: true });
            debugData.screenshots.push(screenshotPath);

            // 4. بررسی وجود محتوای اصلی
            const selectorsToCheck = [
                SELECTORS.QUESTION,
                SELECTORS.ANSWER
            ];

            for (const selector of selectorsToCheck) {
                try {
                    await page.waitForSelector(selector, { timeout: 15000 });
                } catch (selectorError) {
                    debugData.errors.push({
                        type: 'SELECTOR_ERROR',
                        selector,
                        message: selectorError.message,
                        timestamp: new Date().toISOString()
                    });

                    // اسکرین‌شات از بخش مشکل‌دار
                    const selectorScreenshot = `debug/${Date.now()}_${selector.replace(/[^a-z0-9]/gi, '_')}.png`;
                    await page.screenshot({ path: selectorScreenshot });
                    debugData.screenshots.push(selectorScreenshot);

                    throw new Error(`Selector not found: ${selector}`);
                }
            }

            // 5. استخراج محتوا
            debugData.timestamps.contentExtractionStart = new Date().toISOString();
            const content = await this.extractContent(page);
            debugData.timestamps.contentExtractionEnd = new Date().toISOString();

            return content;
        } catch (error) {
            // ذخیره اطلاعات دیباگ
            debugData.timestamps.error = new Date().toISOString();
            debugData.error = {
                name: error.name,
                message: error.message,
                stack: error.stack
            };

            // ذخیره داده‌های دیباگ
            const debugFilePath = `debug/${Date.now()}_debug.json`;
            fs.writeFileSync(debugFilePath, JSON.stringify(debugData, null, 2));
            logger.error(`Debug data saved to ${debugFilePath}`);

            throw error;
        } finally {
            try {
                await page.close();
                await browser.close();
                debugData.timestamps.end = new Date().toISOString();
            } catch (closeError) {
                logger.error('Error closing browser:', closeError);
            }
        }
    }

    async extractContent(page) {
        // بررسی وجود عناصر قبل از استخراج
        await this.checkSelectors(page);

        return await page.evaluate((selectors) => {
            const getContent = (selector) => {
                const el = document.querySelector(selector);
                if (!el) {
                    console.error(`Element not found for selector: ${selector}`);
                    return null;
                }
                return el.textContent.trim();
            };

            return {
                question: getContent(selectors.QUESTION),
                answer: getContent(selectors.ANSWER)
            };
        }, SELECTORS);
    }

    async checkSelectors(page) {
        const check = async (selector) => {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                return true;
            } catch {
                logger.error(`Selector not found: ${selector}`);
                return false;
            }
        };

        const results = await Promise.all([
            check(SELECTORS.QUESTION),
            check(SELECTORS.ANSWER)
        ]);

        if (results.some(valid => !valid)) {
            throw new Error('Required selectors not found');
        }
    }

    saveResult(url, content) {
        try {
            const outputDir = path.join(__dirname, '../../', FILES.OUTPUT_DIR);
            const fileName = `result_${Date.now()}.json`;
            const filePath = path.join(outputDir, fileName);

            const result = {
                url,
                timestamp: new Date().toISOString(),
                status: 'completed',
                content
            };

            fs.writeFileSync(filePath, JSON.stringify(result, null, 2));
            logger.info(`Result saved to ${filePath}`);
        } catch (error) {
            logger.error('Failed to save result:', error);
            throw error;
        }
    }
}

module.exports = new LinkProcessor();