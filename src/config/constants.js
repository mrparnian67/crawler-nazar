module.exports = {
    FILES: {
        LINKS: 'data/crawler_links.json',
        OUTPUT_DIR: 'output/results',
        STATUS: 'output/processing_status.json' // تغییر نام فایل وضعیت
    },
    SELECTORS: {
        QUESTION: 'div[title*="موضوع نظریه"]',
        ANSWER: 'div[title*="جواب نظریه"]',
        THEORY_INFO: 'div.theory-info'
    },
    BROWSER: {
        TIMEOUT: 180000,
        MAX_CONCURRENCY: 3,
        ARGS: [
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    }
};