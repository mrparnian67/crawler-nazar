const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function getCurrentTimestamp() {
    return new Date().toISOString();
}

function formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);

    return `${hours}h ${minutes}m ${seconds}s`;
}

module.exports = {
    sleep,
    getCurrentTimestamp,
    formatDuration
};