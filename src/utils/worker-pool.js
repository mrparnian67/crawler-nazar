class WorkerPool {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.taskQueue = [];
        this.activeTasks = 0;
    }

    async run(task) {
        return new Promise((resolve, reject) => {
            const execute = async () => {
                this.activeTasks++;
                try {
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    this.activeTasks--;
                    this.next();
                }
            };

            this.taskQueue.push(execute);
            this.next();
        });
    }

    next() {
        while (this.activeTasks < this.concurrency && this.taskQueue.length > 0) {
            const task = this.taskQueue.shift();
            task();
        }
    }

    async drain() {
        while (this.activeTasks > 0 || this.taskQueue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

module.exports = WorkerPool;