const crypto = require('crypto');

function getCredentials() {
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
  };
}

function isConfigured() {
  const { cloudName, apiKey, apiSecret } = getCredentials();
  return Boolean(cloudName && apiKey && apiSecret);
}

/**
 * Uploads an image Buffer to Cloudinary using direct REST API (zero external npm dependencies)
 * @param {Buffer} buffer - Image file buffer
 * @param {Object} options - Upload options (folder, tags, etc.)
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

  const folder = options.folder || 'birthday_memories';
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

module.exports = {
  getCredentials,
  isConfigured,
  uploadImageBuffer,
};
