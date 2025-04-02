const path = require('path');
const fs = require('fs');
const { FILES, SELECTORS, BROWSER } = require('../config/constants');
const BrowserManager = require('./browser');
const logger = require('../utils/logger');
const { sleep, formatDuration } = require('../utils/helpers');

class LinkProcessor {
    constructor() {
        this.maxRetries = parseInt(process.env.MAX_RETRIES) || 3;
        this.concurrency = BROWSER.MAX_CONCURRENCY;
        this.activeTasks = 0;
        this.taskQueue = [];
        this.processedLinks = this.loadProcessedLinks();
        this.browserInstance = null; // مرورگر ثابت
        this.ensureOutputDirectory();
    }

    ensureOutputDirectory() {
        const outputDir = path.join(__dirname, '../../', FILES.OUTPUT_DIR);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
    }

    loadProcessedLinks() {
        const statePath = path.join(__dirname, '../../', FILES.STATUS);
        if (fs.existsSync(statePath)) {
            return new Set(JSON.parse(fs.readFileSync(statePath, 'utf8')));
        }
        return new Set();
    }

    saveProcessedLinks() {
        const statePath = path.join(__dirname, '../../', FILES.STATUS);
        fs.writeFileSync(statePath, JSON.stringify([...this.processedLinks], null, 2));
    }

    loadLinks() {
        try {
            const filePath = path.join(__dirname, '../../', FILES.LINKS);
            const data = fs.readFileSync(filePath, 'utf8');
            const links = JSON.parse(data);

            if (!Array.isArray(links)) {
                throw new Error('Links file does not contain valid array');
            }

            return links ;
        } catch (error) {
            logger.error('Error loading links:', error);
            throw error;
        }
    }

    async processLinks() {
        try {
            const links = this.loadLinks().filter(url => !this.processedLinks.has(url));
            if (links.length === 0) {
                logger.warn('No new links to process');
                return;
            }

            this.browserInstance = await BrowserManager.launch();
            logger.info(`Processing ${links.length} new links with concurrency ${this.concurrency}`);

            // ایجاد تمام تسک‌ها به صورت موازی با محدودیت concurrency
            await Promise.all(links.map(url =>
                this.enqueueTask(url)
            ));

            await this.drainQueue();
            await this.browserInstance.close();
            this.saveProcessedLinks();
        } catch (error) {
            logger.error('Error in processLinks:', error);
        }
    }

    async enqueueTask(url) {
        return new Promise((resolve) => {
            const task = async () => {
                try {
                    logger.info(`Processing URL: ${url}`);
                    const content = await this.processLinkWithRetry(url);
                    this.saveResult(url, content);
                    this.processedLinks.add(url);
                } catch (error) {
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

    async processLinkWithRetry(url) {
        let attempt = 0;
        while (attempt < this.maxRetries) {
            attempt++;
            try {
                return await this.attemptProcessing(url);
            } catch (error) {
                if (attempt < this.maxRetries) {
                    await sleep(2000 * attempt);
                } else {
                    throw error;
                }
            }
        }
    }

    async attemptProcessing(url) {
        const page = await BrowserManager.newPage(this.browserInstance);
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: BROWSER.TIMEOUT });
            const content = await this.extractContent(page);
            return content;
        } finally {
            await page.close();
        }
    }

    saveResult(url, content) {
        const outputDir = path.join(__dirname, '../../', FILES.OUTPUT_DIR);
        const filePath = path.join(outputDir, `result_${Date.now()}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ url, content }, null, 2));
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

    async drainQueue() {
        while (this.activeTasks > 0 || this.taskQueue.length > 0) {
            await sleep(100);
        }
    }
}

module.exports = new LinkProcessor();
