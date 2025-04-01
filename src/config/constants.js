module.exports = {
    FILES: {
        LINKS: 'data/crawler_links.json',
        OUTPUT_DIR: 'data/links',
        STATUS: 'data/processing_status.json'
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