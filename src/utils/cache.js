/**
 * Memory-aware LRU cache for sticker buffers
 * ⚡ Tracks total byte usage to prevent OOM on 512MB RAM deployments (Koyeb)
 *
 * Why byte-tracking matters:
 * Old cache with 100 entries × ~500KB avg sticker = ~50MB uncapped.
 * On 512MB RAM (Node ~80MB base + Baileys ~40MB), that leaves little
 * headroom for FFmpeg/sharp processing spikes.
 */
class LRUCache {
    /**
     * @param {number} maxSize  - Maximum number of cached entries
     * @param {number} maxBytes - Maximum total bytes stored (hard cap)
     */
    constructor(maxSize = 50, maxBytes = 20 * 1024 * 1024) {
        this.maxSize = maxSize;
        this.maxBytes = maxBytes;
        this.cache = new Map();
        this.totalBytes = 0;
    }

    /** Estimate byte cost of a cached value */
    _byteSize(value) {
        if (Buffer.isBuffer(value)) return value.length;
        return 256; // fallback for non-buffer values
    }

    get(key) {
        if (!this.cache.has(key)) return null;
        const entry = this.cache.get(key);
        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    set(key, value) {
        const bytes = this._byteSize(value);

        // If updating existing key, subtract old size first
        if (this.cache.has(key)) {
            this.totalBytes -= this.cache.get(key).bytes;
            this.cache.delete(key);
        }

        // ⚡ Evict oldest entries until within both count AND byte limits
        while (this.cache.size > 0 &&
               (this.cache.size >= this.maxSize || this.totalBytes + bytes > this.maxBytes)) {
            const oldestKey = this.cache.keys().next().value;
            this.totalBytes -= this.cache.get(oldestKey).bytes;
            this.cache.delete(oldestKey);
        }

        this.cache.set(key, { value, bytes });
        this.totalBytes += bytes;
    }

    has(key) {
        return this.cache.has(key);
    }

    /** Current memory usage in bytes (useful for monitoring) */
    get memoryUsage() { return this.totalBytes; }
    /** Current entry count */
    get size() { return this.cache.size; }
}

/**
 * Process queue — runs tasks with bounded concurrency and timeout safety
 * Prevents FFmpeg/sharp/heavy downloads from OOM on 512MB RAM deployments
 */
class ProcessQueue {
    constructor(maxConcurrent = 1, defaultTimeoutMs = 45000) {
        this.queue = [];
        this.running = 0;
        this.maxConcurrent = maxConcurrent;
        this.defaultTimeoutMs = defaultTimeoutMs;
    }

    async add(task, timeoutMs = this.defaultTimeoutMs) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject, timeoutMs });
            this.processNext();
        });
    }

    async processNext() {
        if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
        this.running++;
        const { task, resolve, reject, timeoutMs } = this.queue.shift();

        const controller = new AbortController();
        let timer = null;
        let isDone = false;

        const timeoutPromise = new Promise((_, rej) => {
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    if (!isDone) {
                        isDone = true;
                        try { controller.abort(); } catch {}
                        rej(new Error(`Task timeout exceeded (${Math.round(timeoutMs / 1000)}s)`));
                    }
                }, timeoutMs);
            }
        });

        try {
            const taskPromise = Promise.resolve().then(() => task(controller.signal));
            const result = await Promise.race([taskPromise, timeoutPromise]);
            isDone = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        } catch (err) {
            isDone = true;
            if (timer) clearTimeout(timer);
            try { controller.abort(); } catch {}
            reject(err);
        } finally {
            this.running--;
            this.processNext();
        }
    }

    get pending() { return this.queue.length; }
    get active() { return this.running; }
}

const activeFfmpegCommands = new Set();
function registerFfmpegCommand(cmd) {
    activeFfmpegCommands.add(cmd);
    const cleanup = () => activeFfmpegCommands.delete(cmd);
    cmd.on('end', cleanup);
    cmd.on('error', cleanup);
}

function killActiveFfmpegCommands() {
    for (const cmd of activeFfmpegCommands) {
        try { cmd.kill('SIGKILL'); } catch {}
    }
    activeFfmpegCommands.clear();
}

module.exports = {
    // ⚡ Sticker cache: max 50 entries OR 20MB total (was 100 entries, no byte limit)
    stickerCache: new LRUCache(50, 20 * 1024 * 1024),
    // ⚡ Text sticker cache: max 30 entries OR 10MB total (was 50, no byte limit)
    textStickerCache: new LRUCache(30, 10 * 1024 * 1024),
    ffmpegQueue: new ProcessQueue(2, 45000),  // Up to 2 concurrent video encodes (safe for 512MB RAM with ~324MB peak)
    imageQueue: new ProcessQueue(2, 30000),   // Max 2 sharp/sticker operations at a time
    heavyTaskQueue: new ProcessQueue(2, 60000), // Max 2 downloader / PDF operations at a time
    ProcessQueue,
    LRUCache,
    registerFfmpegCommand,
    killActiveFfmpegCommands
};
