const fs = require('fs');
const path = require('path');
const { FILES } = require('../config/constants');

function checkFileSystem() {
    const checks = {
        linksFile: {
            path: path.join(__dirname, '../../', FILES.LINKS),
            exists: false,
            readable: false,
            valid: false
        },
        outputDir: {
            path: path.join(__dirname, '../../', FILES.OUTPUT_DIR),
            exists: false,
            writable: false
        }
    };

    // بررسی فایل links
    try {
        checks.linksFile.exists = fs.existsSync(checks.linksFile.path);
        if (checks.linksFile.exists) {
            const content = fs.readFileSync(checks.linksFile.path, 'utf8');
            JSON.parse(content);
            checks.linksFile.valid = true;
        }
    } catch (e) {
        console.error('Links file check failed:', e);
    }

    // بررسی دایرکتوری خروجی
    try {
        checks.outputDir.exists = fs.existsSync(checks.outputDir.path);
        if (!checks.outputDir.exists) {
            fs.mkdirSync(checks.outputDir.path, { recursive: true });
            checks.outputDir.exists = true;
        }
        // تست نوشتن
        const testFile = path.join(checks.outputDir.path, 'test.txt');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        checks.outputDir.writable = true;
    } catch (e) {
        console.error('Output directory check failed:', e);
    }

    return checks;
}

module.exports = { checkFileSystem };