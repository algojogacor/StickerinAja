// Reddit media converter — converts downloaded media to WhatsApp-compatible WebP stickers.
// Static pipeline: Sharp (resize → contain 512x512 → transparent bg → WebP → iterative quality reduction)
// Animated pipeline: FFmpeg (trim → remove audio → resize/pad 512x512 → animated WebP → iterative reduction)

const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

// ── Config ───────────────────────────────────────────────

const STICKER_SIZE = 512;
const STATIC_MAX_BYTES = () =>
  parseInt(process.env.STICKER_STATIC_MAX_BYTES || "100000", 10);
const ANIMATED_MAX_BYTES = () =>
  parseInt(process.env.STICKER_ANIMATED_MAX_BYTES || "500000", 10);
const ANIMATED_MAX_SECONDS = () =>
  parseInt(process.env.STICKER_ANIMATED_MAX_SECONDS || "10", 10);
const ANIMATED_TARGET_SECONDS = () =>
  parseInt(process.env.STICKER_ANIMATED_TARGET_SECONDS || "6", 10);
const ANIMATED_TARGET_BYTES = () =>
  parseInt(process.env.ANIMATED_STICKER_TARGET_BYTES || "500000", 10);
const CONVERSION_TIMEOUT_MS = () =>
  parseInt(process.env.REDDIT_CONVERSION_TIMEOUT_MS || "45000", 10);

// ── Helpers ──────────────────────────────────────────────

function makeOutputPath(label = "sticker") {
  const time = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(
    process.env.TEMP_DIR || "./temp",
    `reddit_${label}_${time}_${rand}.webp`
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// ── Static conversion ────────────────────────────────────

/**
 * Convert an image buffer to a WhatsApp-compatible static WebP sticker.
 * Iteratively reduces quality until ≤ STATIC_MAX_BYTES.
 *
 * @param {Buffer} buffer - Raw image data
 * @returns {Promise<{buffer: Buffer, filePath: string, fileSizeBytes: number, durationSeconds: null}>}
 */
async function convertStaticSticker(buffer) {
  const maxBytes = STATIC_MAX_BYTES();
  const outputPath = makeOutputPath("static");

  // Quality tiers to try (descending)
  const qualityTiers = [90, 80, 70, 60, 50, 40, 35, 30, 25, 20];

  let bestResult = null;

  for (const quality of qualityTiers) {
    try {
      const result = await sharp(buffer, { animated: false })
        .rotate() // auto-orient
        .resize(STICKER_SIZE, STICKER_SIZE, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .ensureAlpha()
        .webp({
          quality,
          effort: 6,
          lossless: false,
          alphaQuality: quality,
        })
        .toBuffer();

      const tempPath = outputPath + `.q${quality}`;
      fs.writeFileSync(tempPath, result);

      const size = result.length;

      if (!bestResult || size < bestResult.fileSizeBytes) {
        bestResult = { buffer: result, filePath: tempPath, fileSizeBytes: size };
      }

      if (size <= maxBytes) {
        // Clean up other attempts
        if (bestResult.filePath !== tempPath) {
          try { fs.unlinkSync(bestResult.filePath); } catch {}
        }
        bestResult = { buffer: result, filePath: tempPath, fileSizeBytes: size };
        break;
      }
    } catch {
      // Continue to next quality tier
    }
  }

  if (!bestResult) {
    throw new Error("STATIC_CONVERSION_FAILED");
  }

  if (bestResult.filePath !== outputPath) {
    try { fs.renameSync(bestResult.filePath, outputPath); } catch {}
    bestResult.filePath = outputPath;
  }

  if (bestResult.fileSizeBytes > maxBytes) {
    // Still too large — mark but don't reject entirely
    // (WhatsApp may still accept slightly oversized stickers)
  }

  return {
    buffer: bestResult.buffer,
    filePath: bestResult.filePath,
    fileSizeBytes: bestResult.fileSizeBytes,
    durationSeconds: null,
  };
}

// ── Animated conversion ──────────────────────────────────

/**
 * Convert a video/GIF file to an animated WebP sticker.
 * Iteratively reduces FPS/quality/duration until ≤ ANIMATED_MAX_BYTES.
 *
 * @param {string} inputPath - Path to the downloaded media file
 * @returns {Promise<{buffer: Buffer, filePath: string, fileSizeBytes: number, durationSeconds: number}>}
 */
async function convertAnimatedSticker(inputPath) {
  const maxBytes = ANIMATED_MAX_BYTES();
  const targetBytes = ANIMATED_TARGET_BYTES();
  const maxDuration = ANIMATED_MAX_SECONDS();
  const targetDuration = Math.min(ANIMATED_TARGET_SECONDS(), maxDuration);
  const timeoutMs = CONVERSION_TIMEOUT_MS();

  // Probe the media file
  const probe = await probeFile(inputPath);
  const sourceDuration = probe?.duration || 0;

  // Determine effective duration
  const effectiveDuration = Math.min(sourceDuration || targetDuration, targetDuration, maxDuration);

  // Encoding attempt profiles — progressively reduce quality
  const attempts = [
    { fps: 15, quality: 80, duration: effectiveDuration },
    { fps: 12, quality: 70, duration: Math.min(effectiveDuration, 5) },
    { fps: 10, quality: 60, duration: Math.min(effectiveDuration, 4.5) },
    { fps: 8, quality: 50, duration: Math.min(effectiveDuration, 4) },
    { fps: 6, quality: 42, duration: Math.min(effectiveDuration, 3.5) },
  ];

  // Deduplicate attempts
  const seen = new Set();
  const uniqueAttempts = attempts.filter((a) => {
    const key = `${a.fps}-${a.quality}-${a.duration}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const outputPaths = [];
  let bestResult = null;

  for (let i = 0; i < uniqueAttempts.length; i++) {
    const attempt = uniqueAttempts[i];
    const outputPath = makeOutputPath(`anim_a${i}`);
    outputPaths.push(outputPath);

    try {
      await encodeAnimatedWebp(inputPath, outputPath, attempt, timeoutMs);

      const stat = fs.statSync(outputPath);
      const result = {
        filePath: outputPath,
        fileSizeBytes: stat.size,
        durationSeconds: attempt.duration,
        fps: attempt.fps,
        quality: attempt.quality,
      };

      if (!bestResult || result.fileSizeBytes < bestResult.fileSizeBytes) {
        bestResult = result;
      }

      if (result.fileSizeBytes <= targetBytes) {
        bestResult = result;
        break;
      }
    } catch {
      // This attempt failed — continue to next
    }
  }

  if (!bestResult) {
    throw new Error("ANIMATED_CONVERSION_FAILED");
  }

  // Read the best result
  const buffer = fs.readFileSync(bestResult.filePath);

  // Clean up other attempts
  for (const p of outputPaths) {
    if (p !== bestResult.filePath) {
      try { fs.unlinkSync(p); } catch {}
    }
  }

  return {
    buffer,
    filePath: bestResult.filePath,
    fileSizeBytes: bestResult.fileSizeBytes,
    durationSeconds: bestResult.durationSeconds,
  };
}

// ── FFmpeg encoding ──────────────────────────────────────

function encodeAnimatedWebp(inputPath, outputPath, attempt, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("CONVERSION_TIMEOUT"));
    }, timeoutMs);

    const filter = [
      `fps=${attempt.fps}`,
      `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos`,
      `pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      "format=yuva420p",
    ].join(",");

    ffmpeg(inputPath)
      .inputOptions([`-t ${attempt.duration}`])
      .outputOptions([
        `-vf ${filter}`,
        "-vcodec libwebp_anim",
        "-loop 0",
        "-preset default",
        "-an",
        "-vsync 0",
        "-compression_level 6",
        `-q:v ${attempt.quality}`,
      ])
      .toFormat("webp")
      .on("end", () => {
        clearTimeout(timer);
        resolve();
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .save(outputPath);
  });
}

// ── Probe ────────────────────────────────────────────────

/**
 * Safely parse frame rate string like "30000/1001" → 29.97
 * or "24/1" → 24. No eval() needed.
 */
function parseFrameRate(rateStr) {
  if (!rateStr || typeof rateStr !== "string") return 0;
  const parts = rateStr.split("/");
  if (parts.length === 2) {
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      return num / den;
    }
  }
  return 0;
}

function probeFile(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        const videoStream = data.streams?.find(
          (s) => s.codec_type === "video"
        );
        resolve({
          duration: videoStream?.duration
            ? parseFloat(videoStream.duration)
            : 0,
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
          codec: videoStream?.codec_name || "",
          fps: parseFrameRate(videoStream?.r_frame_rate),
        });
      } catch {
        resolve(null);
      }
    });
  });
}

// ── Check if media needs animated conversion ─────────────

const ANIMATED_TYPES = ["gif", "video"];

function isAnimatedMedia(mediaType) {
  return ANIMATED_TYPES.includes(mediaType);
}

// ── Sticker data directory ───────────────────────────────

const STICKER_DATA_DIR = path.join(
  process.env.TEMP_DIR || "./temp",
  "..",
  "data",
  "stickers",
  "reddit"
);

function ensureStickerDir() {
  const dir = path.resolve(STICKER_DATA_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Save sticker buffer to persistent storage and return the path.
 */
function saveStickerFile(buffer, stickerType) {
  const dir = ensureStickerDir();
  const time = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `rs_${stickerType}_${time}_${rand}.webp`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = {
  convertStaticSticker,
  convertAnimatedSticker,
  isAnimatedMedia,
  probeFile,
  saveStickerFile,
  STICKER_DATA_DIR,
  formatBytes,
};
