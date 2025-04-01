const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const formatDuration = ms => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
};

module.exports = {
    sleep,
    formatDuration
};