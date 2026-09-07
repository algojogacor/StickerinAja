const crypto = require('crypto');

function getCredentials() {
  let cloudName = process.env.CLOUDINARY_CLOUD_NAME || '';
  let apiKey = process.env.CLOUDINARY_API_KEY || '';
  let apiSecret = process.env.CLOUDINARY_API_SECRET || '';

  // Fallback to parsing CLOUDINARY_URL if individual env variables are not set
  if ((!cloudName || !apiKey || !apiSecret) && process.env.CLOUDINARY_URL) {
    const match = String(process.env.CLOUDINARY_URL).trim().match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/i);
    if (match) {
      apiKey = apiKey || match[1];
      apiSecret = apiSecret || match[2];
      cloudName = cloudName || match[3];
    }
  }

  return {
    cloudName,
    apiKey,
    apiSecret,
  };
}

function isConfigured() {
  const { cloudName, apiKey, apiSecret } = getCredentials();
  return Boolean(cloudName && apiKey && apiSecret);
}

/**
 * Uploads an image Buffer to Cloudinary using direct REST API (zero external npm dependencies)
 * @param {Buffer} buffer - Image file buffer
 * @param {Object|string} options - Upload options or folder name string
 * @returns {Promise<{ success: boolean, url?: string, publicId?: string, error?: string }>}
 */
async function uploadImageBuffer(buffer, options = {}) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    return { success: false, error: 'Buffer gambar tidak valid' };
  }

  const { cloudName, apiKey, apiSecret } = getCredentials();
  if (!cloudName || !apiKey || !apiSecret) {
    return { success: false, error: 'Kredensial Cloudinary belum lengkap di environment' };
  }

  const opts = typeof options === 'string' ? { folder: options } : (options || {});
  const folder = opts.folder || 'birthday_memories';
  const timestamp = Math.floor(Date.now() / 1000);

  // Sign parameters alphabetically
  const toSign = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');

  const formData = new FormData();
  const base64Data = `data:image/jpeg;base64,${buffer.toString('base64')}`;
  formData.append('file', base64Data);
  formData.append('api_key', apiKey);
  formData.append('timestamp', String(timestamp));
  formData.append('folder', folder);
  formData.append('signature', signature);

  try {
    const uploadUrl = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
    const res = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (res.ok && (data.secure_url || data.url)) {
      return {
        success: true,
        url: data.secure_url || data.url,
        publicId: data.public_id,
        bytes: data.bytes,
        format: data.format,
      };
    }

    const errMsg = data.error?.message || `HTTP ${res.status}`;
    return { success: false, error: errMsg };
  } catch (err) {
    return { success: false, error: err.message || 'Gagal mengunggah ke Cloudinary' };
  }
}

const uploadImage = uploadImageBuffer;

module.exports = {
  getCredentials,
  isConfigured,
  uploadImageBuffer,
  uploadImage,
};
