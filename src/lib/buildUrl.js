
const UPLOADS_BASE = process.env.API_UPLOADS_HOST || 'https://apisprada.exotech.co.in';

function buildImageUrl(imagePath) {
  if (!imagePath) return null;

  // Already a full URL?
  if (/^https?:\/\//i.test(imagePath)) return imagePath;

  // Ensure leading slash
  if (!imagePath.startsWith('/')) imagePath = '/' + imagePath;

  return UPLOADS_BASE + imagePath;
}

module.exports = { buildImageUrl };
