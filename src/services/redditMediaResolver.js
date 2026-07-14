// Reddit media resolver — extracts the best media URL and type from a Reddit post.
// Supports: static images, galleries, Reddit-hosted video, GIF, crossposts.

// ── Helpers ──────────────────────────────────────────────

function unescapeHtml(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function getPostAgeHours(createdUtc) {
  if (!createdUtc) return 9999;
  const now = Math.floor(Date.now() / 1000);
  return (now - Number(createdUtc)) / 3600;
}

// ── Post eligibility ─────────────────────────────────────

function isEligibleRedditPost(post) {
  if (!post?.id) return false;
  if (post.removed_by_category) return false;
  if (post.is_self) return false;
  if (post.stickied) return false;

  if (process.env.REDDIT_ALLOW_NSFW !== "true" && post.over_18) {
    return false;
  }

  if (process.env.REDDIT_ALLOW_SPOILER !== "true" && post.spoiler) {
    return false;
  }

  return true;
}

function meetsScoreThreshold(post) {
  const minScore = parseInt(process.env.REDDIT_MIN_SCORE || "200", 10);
  return (post.score || 0) >= minScore;
}

function meetsAgeThreshold(post) {
  const maxAgeHours = parseInt(process.env.REDDIT_MAX_POST_AGE_HOURS || "48", 10);
  return getPostAgeHours(post.created_utc) <= maxAgeHours;
}

// ── Media resolution ─────────────────────────────────────

/**
 * Resolve the best available media from a Reddit post.
 * Returns { mediaUrl, mediaType, thumbnailUrl, duration, isGallery, galleryCount, originalPostId }
 * or null if no supported media is found.
 */
function resolveMedia(post) {
  if (!post) return null;

  // Check for crosspost first — resolve from original if wrapper has no media
  const crosspostResult = resolveCrosspost(post);

  // ── Gallery ──
  const galleryResult = resolveGallery(post);
  if (galleryResult) return galleryResult;

  // ── Reddit-hosted video ──
  const videoResult = resolveVideo(post);
  if (videoResult) return videoResult;

  // ── Direct image (non-gallery) ──
  const imageResult = resolveImage(post, crosspostResult);
  if (imageResult) return imageResult;

  // ── Crosspost fallback: resolve from parent post ──
  if (crosspostResult) {
    const parent = crosspostResult.parentPost;
    const parentImage = _resolveImageMedia(parent);
    if (parentImage) {
      return {
        ...parentImage,
        originalPostId: parent.id || null,
        isCrosspost: true,
      };
    }
  }

  // ── External link — only allow known Reddit hosts ──
  const externalResult = resolveExternalUrl(post);
  if (externalResult) return externalResult;

  return null;
}

// ── Crosspost resolution ─────────────────────────────────

function resolveCrosspost(post) {
  const parentList = post.crosspost_parent_list;
  if (!Array.isArray(parentList) || parentList.length === 0) return null;

  const parent = parentList[0];
  if (!parent?.id) return null;

  return {
    parentPost: parent,
    parentId: parent.id,
    parentSubreddit: parent.subreddit || "",
  };
}

// ── Gallery resolution ───────────────────────────────────

function resolveGallery(post) {
  // Check for media_metadata (new Reddit gallery format)
  const mediaMetadata = post.media_metadata || post.gallery_data?.items;
  if (!mediaMetadata) return null;

  // Get gallery item IDs
  let itemIds = [];
  if (post.gallery_data?.items && Array.isArray(post.gallery_data.items)) {
    itemIds = post.gallery_data.items.map((item) => item.media_id);
  } else if (typeof mediaMetadata === "object") {
    itemIds = Object.keys(mediaMetadata);
  }

  if (itemIds.length === 0) return null;

  // Pick the first item with a valid image
  for (const id of itemIds) {
    const meta = mediaMetadata[id];
    if (!meta) continue;

    // s = source, highest quality
    const formats = meta.p || meta.s || meta.m || meta.u;
    let url = null;

    if (meta.s?.u) url = unescapeHtml(meta.s.u);
    else if (meta.p) {
      // p is an array of previews, take the last (largest)
      const previews = Array.isArray(meta.p) ? meta.p : [];
      const best = previews[previews.length - 1];
      if (best?.u) url = unescapeHtml(best.u);
    }

    if (!url) continue;

    return {
      mediaUrl: url,
      mediaType: "image",
      thumbnailUrl: null,
      isGallery: true,
      galleryCount: itemIds.length,
    };
  }

  return null;
}

// ── Video resolution ─────────────────────────────────────

function resolveVideo(post) {
  // Check is_video flag
  if (post.is_video) {
    const media = post.media || post.secure_media;
    const redditVideo = media?.reddit_video;

    if (redditVideo?.fallback_url) {
      return {
        mediaUrl: unescapeHtml(redditVideo.fallback_url),
        mediaType: post.is_gif ? "gif" : "video",
        thumbnailUrl: post.thumbnail || null,
        duration: redditVideo.duration || 0,
        hasAudio: redditVideo.has_audio || false,
      };
    }

    // Fallback: use the URL directly
    if (post.url) {
      const url = unescapeHtml(post.url);
      if (url.includes("v.redd.it") || url.includes(".mp4")) {
        return {
          mediaUrl: url,
          mediaType: post.is_gif ? "gif" : "video",
          thumbnailUrl: post.thumbnail || null,
          duration: 0,
          hasAudio: false,
        };
      }
    }
  }

  // Check preview for Reddit video (some posts have is_video in preview but not top-level)
  const previewVideo = post.preview?.reddit_video_preview;
  if (previewVideo?.fallback_url) {
    return {
      mediaUrl: unescapeHtml(previewVideo.fallback_url),
      mediaType: "gif",
      thumbnailUrl: post.thumbnail || null,
      duration: previewVideo.duration || 0,
      hasAudio: false,
    };
  }

  // Check secure_media for embedded video
  const secureMedia = post.secure_media || post.media;
  if (secureMedia?.reddit_video?.fallback_url) {
    return {
      mediaUrl: unescapeHtml(secureMedia.reddit_video.fallback_url),
      mediaType: post.is_gif ? "gif" : "video",
      thumbnailUrl: post.thumbnail || null,
      duration: secureMedia.reddit_video.duration || 0,
      hasAudio: secureMedia.reddit_video.has_audio || false,
    };
  }

  return null;
}

// ── Image resolution ─────────────────────────────────────

function resolveImage(post, crosspostResult) {
  // Only resolve from the given post. Crosspost parent is handled by
  // the crosspost fallback in resolveMedia() which adds isCrosspost metadata.
  return _resolveImageMedia(post);
}

function _resolveImageMedia(sourcePost) {
  // 1. url_overridden_by_dest — highest quality
  if (sourcePost.url_overridden_by_dest) {
    const url = unescapeHtml(sourcePost.url_overridden_by_dest);
    if (isImageExtension(url) || isRedditImageHost(url)) {
      return {
        mediaUrl: url,
        mediaType: "image",
        thumbnailUrl: sourcePost.thumbnail || null,
      };
    }
  }

  // 2. preview.images[0].source.url — best for Reddit-hosted images
  const previewImages = sourcePost.preview?.images;
  if (Array.isArray(previewImages) && previewImages.length > 0) {
    const firstPreview = previewImages[0];

    if (firstPreview.source?.url) {
      let url = unescapeHtml(firstPreview.source.url);
      if (isRedditImageHost(url)) {
        return {
          mediaUrl: url,
          mediaType: "image",
          thumbnailUrl: firstPreview.source.url,
        };
      }
    }

    const resolutions = firstPreview.resolutions || [];
    if (resolutions.length > 0) {
      const best = resolutions[resolutions.length - 1];
      if (best?.url) {
        return {
          mediaUrl: unescapeHtml(best.url),
          mediaType: "image",
          thumbnailUrl: firstPreview.source?.url || null,
        };
      }
    }
  }

  // 3. Direct URL — for i.redd.it or direct image links
  if (sourcePost.url) {
    const url = unescapeHtml(sourcePost.url);
    if (isDirectImageUrl(url) || isRedditImageHost(url)) {
      return {
        mediaUrl: url,
        mediaType: "image",
        thumbnailUrl: sourcePost.thumbnail || null,
      };
    }
  }

  // 4. Thumbnail as last resort
  if (sourcePost.thumbnail && !["self", "default", "nsfw", "spoiler", "image"].includes(sourcePost.thumbnail)) {
    const thumbUrl = unescapeHtml(sourcePost.thumbnail);
    if (thumbUrl.startsWith("https://") && (isRedditImageHost(thumbUrl) || isDirectImageUrl(thumbUrl))) {
      return {
        mediaUrl: thumbUrl,
        mediaType: "image",
        thumbnailUrl: thumbUrl,
        isThumbnail: true,
      };
    }
  }

  return null;
}

// ── External URL resolution ──────────────────────────────

function resolveExternalUrl(post) {
  const urlStr = post.url || post.url_overridden_by_dest || "";
  if (!urlStr) return null;

  const url = unescapeHtml(urlStr);

  // Check the post_hint
  if (post.post_hint === "link" && isDirectImageUrl(url)) {
    return {
      mediaUrl: url,
      mediaType: isGifExtension(url) ? "gif" : "image",
      thumbnailUrl: post.thumbnail || null,
    };
  }

  // GIF from external host (imgur, gfycat, etc.)
  if (isGifExtension(url)) {
    return {
      mediaUrl: url,
      mediaType: "gif",
      thumbnailUrl: post.thumbnail || null,
    };
  }

  // Direct video link
  if (isVideoExtension(url)) {
    return {
      mediaUrl: url,
      mediaType: "video",
      thumbnailUrl: post.thumbnail || null,
    };
  }

  // i.imgur.com links
  if (url.includes("i.imgur.com") && isDirectImageUrl(url)) {
    return {
      mediaUrl: url,
      mediaType: "image",
      thumbnailUrl: post.thumbnail || null,
    };
  }

  return null;
}

// ── URL pattern helpers ──────────────────────────────────

function isRedditImageHost(url) {
  if (!url) return false;
  // Matches URLs from i.redd.it or preview.redd.it
  return /^https?:\/\/(i\.redd\.it|preview\.redd\.it)\//.test(url);
}

function isDirectImageUrl(url) {
  if (!url) return false;
  return /\.(jpe?g|png|webp|gif)(\?.*)?$/i.test(url);
}

function isImageExtension(url) {
  if (!url) return false;
  return /\.(jpe?g|png|webp)(\?.*)?$/i.test(url);
}

function isGifExtension(url) {
  if (!url) return false;
  return /\.gif(\?.*)?$/i.test(url);
}

function isVideoExtension(url) {
  if (!url) return false;
  return /\.(mp4|webm)(\?.*)?$/i.test(url);
}

// ── Ranking ──────────────────────────────────────────────

function calculateRedditRank(post) {
  const score = Math.max(0, Number(post.score || 0));
  const comments = Math.max(0, Number(post.num_comments || 0));
  const ratio = Number(post.upvote_ratio || 0);
  const ageHours = getPostAgeHours(post.created_utc);
  const freshnessMultiplier = Math.max(0.1, 1 - ageHours / 72);

  return (
    Math.log10(score + 1) * 5 +
    Math.log10(comments + 1) * 2 +
    ratio * 3
  ) * freshnessMultiplier;
}

// ── Filter & rank pipeline ───────────────────────────────

/**
 * Filter and rank a list of Reddit posts. Returns sorted eligible candidates.
 */
function filterAndRankPosts(posts, { seenIds = new Set() } = {}) {
  return posts
    .filter((post) => {
      if (!isEligibleRedditPost(post)) return false;
      if (!meetsScoreThreshold(post)) return false;
      if (!meetsAgeThreshold(post)) return false;
      if (seenIds.has(post.id)) return false;

      // Must have resolvable media
      const media = resolveMedia(post);
      if (!media) return false;

      // Attach media info for downstream use
      post._resolvedMedia = media;
      post._rank = calculateRedditRank(post);

      return true;
    })
    .sort((a, b) => b._rank - a._rank);
}

module.exports = {
  isEligibleRedditPost,
  meetsScoreThreshold,
  meetsAgeThreshold,
  resolveMedia,
  resolveCrosspost,
  resolveGallery,
  resolveVideo,
  resolveImage,
  resolveExternalUrl,
  calculateRedditRank,
  filterAndRankPosts,
  getPostAgeHours,
  unescapeHtml,
};
