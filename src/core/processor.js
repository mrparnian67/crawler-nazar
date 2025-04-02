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

    // متد saveProcessedData به این صورت تغییر می‌کند:
    saveProcessedData() {
        const statePath = path.join(__dirname, '../../', FILES.STATUS);
        const dataToSave = Array.from(this.processedData.values()); // فقط مقادیر را ذخیره می‌کنیم
        fs.writeFileSync(statePath, JSON.stringify(dataToSave, null, 2));
    }

    loadProcessedData() {
        const statePath = path.join(__dirname, '../../', FILES.STATUS);
        if (fs.existsSync(statePath)) {
            try {
                const dataArray = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                const dataMap = new Map();

                dataArray.forEach(item => {
                    if (item && item.url) {
                        // تبدیل ساختار قدیم به جدید اگر نیاز باشد
                        if (!item.attempts) {
                            item.attempts = [];
                            if (item.status === 'failed') {
                                item.attempts.push({
                                    attemptNumber: 1,
                                    status: 'failed',
                                    error: item.error || 'Unknown error',
                                    timestamp: item.endTime || item.startTime
                                });
                            }
                        }
                        dataMap.set(item.url, item);
                    }
                });

                return dataMap;
            } catch (e) {
                logger.error('Error parsing status file, creating new one:', e);
                return new Map();
            }
        }
        return new Map();
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
            const now = Date.now();

            const pendingLinks = links.filter(url => {
                const existing = this.processedData.get(url);

                if (!existing) {
                    return true; // صفحه جدید
                }

                if (existing.status === 'completed') {
                    return false; // صفحه قبلاً با موفقیت پردازش شده
                }

                if (existing.status === 'failed_permanent') {
                    return false; // خطای دائمی - دیگر پردازش نمی‌شود
                }

                // محاسبه زمان مناسب برای تلاش مجدد
                const nextRetryTime = this.getNextRetryTime(url);
                return nextRetryTime <= now; // آیا زمان تلاش مجدد رسیده؟
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
                const existingData = this.processedData.get(url) || {
                    url,
                    startTime: getCurrentTimestamp(),
                    attempts: [],
                    status: 'processing'
                };

                try {
                    logger.info(`Processing URL: ${url}, attempt ${existingData.attempts.length + 1}`);
                    const result = await this.processLinkWithRetry(url, existingData);
                    const filename = await this.saveResult(url, result.content);

                    this.processedData.set(url, {
                        ...existingData,
                        endTime: getCurrentTimestamp(),
                        status: 'completed',
                        contentFile: filename,
                        attempts: result.attempts,
                        pageTitle: result.content.pageTitle
                    });

                } catch (error) {
                    const attempts = existingData.attempts.length + 1;
                    const canRetryLater = attempts < this.maxTotalAttempts;

                    // ذخیره اطلاعات خطا
                    const filename = await this.saveResult(url, {
                        pageTitle: `Failed to load - ${url}`,
                        error: error.message,
                        attempt: attempts
                    });

                    this.processedData.set(url, {
                        ...existingData,
                        endTime: getCurrentTimestamp(),
                        status: canRetryLater ? 'failed_retryable' : 'failed_permanent',
                        error: error.message,
                        contentFile: filename,
                        attempts: [...existingData.attempts, {
                            attemptNumber: attempts,
                            status: 'failed',
                            error: error.message,
                            timestamp: getCurrentTimestamp()
                        }]
                    });

                    if (canRetryLater) {
                        const nextRetry = new Date(Date.now() + this.calculateRetryDelay(attempts));
                        logger.warn(`Will retry ${url} at ${nextRetry.toISOString()}`);
                    } else {
                        logger.error(`Permanent failure for ${url} after ${attempts} attempts`);
                    }
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
                attemptNumber: attempts.length + 1,
                startTime: getCurrentTimestamp()
            };

            try {
                const content = await this.attemptProcessing(url, attemptData);
                return {
                    content,
                    attempts: [...attempts, {
                        ...attemptData,
                        status: 'success',
                        endTime: getCurrentTimestamp(),
                        duration: formatDuration(Date.now() - new Date(attemptData.startTime).getTime())
                    }]
                };
            } catch (error) {
                attempts.push({
                    ...attemptData,
                    status: 'failed',
                    endTime: getCurrentTimestamp(),
                    error: error.message,
                    duration: formatDuration(Date.now() - new Date(attemptData.startTime).getTime())
                });

                if (attempt < this.maxRetries) {
                    const delay = this.calculateRetryDelay(attempt);
                    logger.warn(`Retrying ${url} in ${delay}ms (attempt ${attempt + 1}/${this.maxRetries})`);
                    await sleep(delay);
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

            // استخراج عنوان صفحه قبل از استخراج محتوا
            const pageTitle = await page.title();
            const content = await this.extractContentWithMetrics(page, attemptData);

            return {
                ...content,
                pageTitle: pageTitle || `No title - ${url}`
            };
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
                    // عنوان صفحه قبلاً گرفته شده است
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

    async saveResult(url, content) {
        const outputDir = path.join(__dirname, '../../', FILES.OUTPUT_DIR);

        // تولید نام فایل
        let titlePart = '';
        if (content?.pageTitle) {
            titlePart = content.pageTitle.split(/\s+/).slice(0, 5).join('_')
                .replace(/[^\w]/g, '').substring(0, 100);
        } else {
            titlePart = url.replace(/^https?:\/\//, '')
                .replace(/\/.*$/, '')
                .replace(/[^\w]/g, '_')
                .substring(0, 50);
        }

        const filename = `result_${titlePart}_${Date.now()}.json`;
        const filePath = path.join(outputDir, filename);

        // ساختار نهایی فایل خروجی
        const resultData = {
            metadata: {
                url,
                processedAt: getCurrentTimestamp(),
                sourceFile: filename,
                status: content.error ? 'failed' : 'success'
            },
            content: {
                ...content,
                url: url // تضمین وجود URL در محتوا
            }
        };

        fs.writeFileSync(filePath, JSON.stringify(resultData, null, 2));
        return filename;
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

    calculateRetryDelay(attemptNumber) {
        return Math.min(
            this.retryDelay.initial * Math.pow(this.retryDelay.multiplier, attemptNumber - 1),
            this.retryDelay.max
        );
    }

    getNextRetryTime(url) {
        const data = this.processedData.get(url);
        if (!data || data.status !== 'failed_retryable') return 0;

        const lastAttempt = data.attempts[data.attempts.length - 1];
        const delay = this.calculateRetryDelay(data.attempts.length);
        return new Date(lastAttempt.timestamp).getTime() + delay;
    }

}

module.exports = new EnhancedLinkProcessor();