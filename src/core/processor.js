const path = require('path');
const fs = require('fs');
const { FILES, SELECTORS, BROWSER } = require('../config/constants');
const BrowserManager = require('./browser');
const logger = require('../utils/logger');
const { sleep, formatDuration, getCurrentTimestamp } = require('../utils/helpers');

class EnhancedLinkProcessor {
    constructor() {
        this.maxRetries = parseInt(process.env.MAX_RETRIES) || 3;
        this.concurrency = BROWSER.MAX_CONCURRENCY;
        this.activeTasks = 0;
        this.taskQueue = [];
        this.processedData = this.loadProcessedData(); // تغییر از processedLinks به processedData
        this.browserInstance = null;
        this.ensureOutputDirectory();
        this.setupExitHandlers();
    }

    setupExitHandlers() {
        // ذخیره وضعیت هنگام خروج غیرمنتظره
        process.on('SIGINT', async () => {
            logger.warn('Received SIGINT. Saving state before exit...');
            await this.cleanup();
            process.exit(0);
        });

        process.on('uncaughtException', async (err) => {
            logger.error('Uncaught exception:', err);
            await this.cleanup();
            process.exit(1);
        });
    }

    ensureOutputDirectory() {
        const outputDir = path.join(__dirname, '../../', FILES.OUTPUT_DIR);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
    }

    loadProcessedData() {
        const statePath = path.join(__dirname, '../../', FILES.STATUS);
        if (fs.existsSync(statePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                // تبدیل آرایه به Map و حذف URL تکراری
                return new Map(data);
            } catch (e) {
                logger.error('Error parsing status file, creating new one:', e);
                return new Map();
            }
        }
        return new Map();
    }

    saveProcessedData() {
        const statePath = path.join(__dirname, '../../', FILES.STATUS);
        // ذخیره به صورت آرایه از جفت‌های [key, value]
        const dataToSave = Array.from(this.processedData.entries());
        fs.writeFileSync(statePath, JSON.stringify(dataToSave, null, 2));
    }

    async cleanup() {
        if (this.browserInstance) {
            await this.browserInstance.close();
        }
        this.saveProcessedData();
    }

    loadLinks() {
        try {
            const filePath = path.join(__dirname, '../../', FILES.LINKS);
            const data = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            logger.error('Error loading links:', error);
            throw error;
        }
    }

    async processLinks() {
        try {
            const links = this.loadLinks();
            const pendingLinks = links.filter(url => {
                const existing = this.processedData.get(url);
                return !existing || existing.status !== 'completed';
            });

            if (pendingLinks.length === 0) {
                logger.warn('No pending links to process');
                return;
            }

            this.browserInstance = await BrowserManager.launch();
            logger.info(`Processing ${pendingLinks.length} pending links`);

            await Promise.all(pendingLinks.map(url => this.enqueueTask(url)));
            await this.drainQueue();
            await this.cleanup();
        } catch (error) {
            logger.error('Error in processLinks:', error);
            await this.cleanup();
        }
    }

    async enqueueTask(url) {
        return new Promise((resolve) => {
            const task = async () => {
                // اگر URL قبلاً پردازش شده، داده‌های موجود را بارگیری می‌کنیم
                const existingData = this.processedData.get(url) || {
                    startTime: getCurrentTimestamp(),
                    attempts: []
                };

                try {
                    const result = await this.processLinkWithRetry(url, existingData);

                    // به‌روزرسانی وضعیت با داده‌های جدید
                    this.processedData.set(url, {
                        ...existingData,
                        endTime: getCurrentTimestamp(),
                        status: 'completed',
                        ...result
                    });

                    this.saveResult(url, result.content);
                } catch (error) {
                    this.processedData.set(url, {
                        ...existingData,
                        endTime: getCurrentTimestamp(),
                        status: 'failed',
                        error: error.message
                    });
                } finally {
                    this.saveProcessedData();
                    resolve();
                }
            };

            this.taskQueue.push(task);
            this.runNextTask();
        });
    }

    async processLinkWithRetry(url, existingData) {
        let attempt = 0;
        const attempts = existingData.attempts || [];

        while (attempt < this.maxRetries) {
            attempt++;
            const attemptData = {
                attemptNumber: attempt,
                startTime: getCurrentTimestamp()
            };

            try {
                const content = await this.attemptProcessing(url, attemptData);
                return {
                    content,
                    attempts: [...attempts, {
                        ...attemptData,
                        status: 'success',
                        endTime: getCurrentTimestamp()
                    }]
                };
            } catch (error) {
                attempts.push({
                    ...attemptData,
                    status: 'failed',
                    endTime: getCurrentTimestamp(),
                    error: error.message
                });

                if (attempt < this.maxRetries) {
                    await sleep(2000 * attempt);
                } else {
                    throw error;
                }
            }
        }
    }

    async attemptProcessing(url, attemptData) {
        const page = await BrowserManager.newPage(this.browserInstance);
        try {
            attemptData.pageLoadStart = getCurrentTimestamp();
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: BROWSER.TIMEOUT
            });
            attemptData.pageLoadEnd = getCurrentTimestamp();

            const content = await this.extractContentWithMetrics(page, attemptData);
            return content;
        } finally {
            await page.close();
        }
    }

    async extractContentWithMetrics(page, attemptData) {
        try {
            attemptData.contentExtractionStart = getCurrentTimestamp();
            await this.checkSelectors(page);

            const content = await page.evaluate((selectors) => {
                const getContent = (selector) => {
                    const el = document.querySelector(selector);
                    return el ? el.textContent.trim() : null;
                };

                return {
                    question: getContent(selectors.QUESTION),
                    answer: getContent(selectors.ANSWER),
                    pageTitle: document.title,
                    url: window.location.href
                };
            }, SELECTORS);

            attemptData.contentExtractionEnd = getCurrentTimestamp();
            return content;
        } catch (error) {
            attemptData.contentError = error.message;
            throw error;
        }
    }

    saveResult(url, content) {
        const outputDir = path.join(__dirname, '../../', FILES.OUTPUT_DIR);

        // استخراج 5 کلمه اول از عنوان صفحه (در صورت وجود)
        const titleWords = content?.pageTitle?.split(/\s+/)?.slice(0, 5) || [];
        const cleanTitle = titleWords.join('_').replace(/[^\w]/g, '');

        // تولید نام فایل
        const filename = `result_${cleanTitle || 'no-title'}_${Date.now()}.json`;
        const filePath = path.join(outputDir, filename);

        fs.writeFileSync(filePath, JSON.stringify({
            url, // ذخیره URL اصلی
            timestamp: getCurrentTimestamp(),
            content
        }, null, 2));
    }

    runNextTask() {
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

    // ... (بقیه متدها مانند قبل)
}

module.exports = new EnhancedLinkProcessor();