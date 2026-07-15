// Reddit media downloader — downloads images, GIFs, and videos with SSRF protection.
// Hostname allowlist is the primary defense. Only Reddit CDN hosts are permitted.

const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

// ── Config ───────────────────────────────────────────────

const ALLOWED_REDDIT_MEDIA_HOSTS = [
  "i.redd.it",
  "preview.redd.it",
  "external-preview.redd.it",
  "v.redd.it",
  "www.reddit.com",
  "reddit.com",
];

const PRIVATE_HOSTNAMES = ["localhost", "0.0.0.0", "[::]", "[::1]"];

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 20000;

// ── Content-Type validation ──────────────────────────────

const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "application/octet-stream",
];

function isAllowedContentType(contentType) {
  if (!contentType) return true;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.includes(base);
}

function isPrivateHostname(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  return PRIVATE_HOSTNAMES.includes(lower);
}

function validateHostname(hostname) {
  if (!hostname || typeof hostname !== "string") return false;
  if (isPrivateHostname(hostname)) return false;
  const lower = hostname.toLowerCase();
  return ALLOWED_REDDIT_MEDIA_HOSTS.some(
    (allowed) => lower === allowed || lower.endsWith("." + allowed)
  );
}

function makeTempPath(extension = "bin") {
  const uuid = crypto.randomUUID();
  return path.join(
    process.env.TEMP_DIR || "./temp",
    `reddit_dl_${uuid}.${extension}`
  );
}

// ── URL validation ───────────────────────────────────────

function validateMediaUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return { ok: false, reason: "empty_url" };

  let url;
  try {
    url = new URL(urlStr.trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, reason: "https_required" };
  }

  const hostname = url.hostname.replace(/^www\./, "").toLowerCase();
  if (!validateHostname(hostname)) {
    return { ok: false, reason: "unsupported_external_host" };
  }

  return { ok: true, url: url.href, hostname };
}

// ── Download ─────────────────────────────────────────────

/**
 * Download a media file from a URL with SSRF protection.
 *
 * @param {string} urlStr - Media URL
 * @param {object} options
 * @param {number} [options.maxBytes] - Max download size in bytes
 * @param {number} [options.timeoutMs] - Download timeout
 * @returns {Promise<{buffer: Buffer, contentType: string, filePath: string}>}
 */
async function downloadMedia(urlStr, options = {}) {
  // 1. Validate URL
  const validation = validateMediaUrl(urlStr);
  if (!validation.ok) {
    throw new Error(validation.reason.toUpperCase());
  }

  const maxBytes =
    options.maxBytes ||
    parseInt(process.env.REDDIT_MEDIA_MAX_DOWNLOAD_MB || "25") * 1024 * 1024;
  const timeoutMs =
    options.timeoutMs ||
    parseInt(process.env.REDDIT_MEDIA_DOWNLOAD_TIMEOUT_MS || "20000");

  // 2. Download with timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(validation.url, {
      method: "GET",
      headers: { "User-Agent": process.env.REDDIT_USER_AGENT || "WhatsAppGroupStickerBot/1.0" },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`HTTP_${res.status}`);
    }

    // Validate Content-Type
    const contentType = res.headers.get("content-type") || "";
    if (!isAllowedContentType(contentType)) {
      throw new Error(`CONTENT_TYPE_REJECTED`);
    }

    // Check Content-Length
    const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
    if (contentLength > maxBytes) {
      throw new Error("CONTENT_TOO_LARGE");
    }

    // Download with size cap
    const chunks = [];
    const reader = res.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.length;
      if (totalBytes > maxBytes) {
        reader.cancel();
        throw new Error("DOWNLOAD_SIZE_EXCEEDED");
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks);

    // Write to temp file
    let ext = "bin";
    const ct = contentType.split(";")[0].trim().toLowerCase();
    if (ct === "image/jpeg") ext = "jpg";
    else if (ct === "image/png") ext = "png";
    else if (ct === "image/webp") ext = "webp";
    else if (ct === "image/gif") ext = "gif";
    else if (ct === "video/mp4") ext = "mp4";
    else if (ct === "video/webm") ext = "webm";

    const filePath = makeTempPath(ext);
    fs.writeFileSync(filePath, buffer);

    return {
      buffer,
      filePath,
      contentType: ct || contentType,
      contentLength: totalBytes,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clean up a downloaded temp file.
 */
function cleanupTempFile(filePath) {
  if (filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already deleted
    }
  }
}

module.exports = {
  downloadMedia,
  cleanupTempFile,
  validateMediaUrl,
  validateHostname,
  ALLOWED_REDDIT_MEDIA_HOSTS,
};
