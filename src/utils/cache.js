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
 * Process queue — runs tasks with bounded concurrency
 * Prevents FFmpeg/sharp from OOM on 512MB RAM
 */
class ProcessQueue {
    constructor(maxConcurrent = 1) {
        this.queue = [];
        this.running = 0;
        this.maxConcurrent = maxConcurrent;
    }

    async add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.processNext();
        });
    }

    async processNext() {
        if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
        this.running++;
        const { task, resolve, reject } = this.queue.shift();
        try {
            const result = await task();
            resolve(result);
        } catch (err) {
            reject(err);
        } finally {
            this.running--;
            this.processNext();
        }
    }

    get pending() { return this.queue.length; }
    get active() { return this.running; }
}

module.exports = {
    // ⚡ Sticker cache: max 50 entries OR 20MB total (was 100 entries, no byte limit)
    stickerCache: new LRUCache(50, 20 * 1024 * 1024),
    // ⚡ Text sticker cache: max 30 entries OR 10MB total (was 50, no byte limit)
    textStickerCache: new LRUCache(30, 10 * 1024 * 1024),
    ffmpegQueue: new ProcessQueue(1),  // 1 video at a time (FFmpeg is memory-hungry)
    // ⚡ Reduced from 3→2: each sharp/Sticker uses ~20-40MB peak, 3 concurrent = ~120MB spike
    imageQueue: new ProcessQueue(2)
};
