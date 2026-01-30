const SUPABASE_PUBLIC_BASE =
  process.env.SUPABASE_PUBLIC_STORAGE_URL ||
  'https://kwthxsumqqssiywdcexv.supabase.co/storage/v1/object/public';

function buildImageUrl(imagePath) {
  if (!imagePath) return null;

  // Already absolute
  if (/^https?:\/\//i.test(imagePath)) return imagePath;

  // normalize
  if (imagePath.startsWith('/')) imagePath = imagePath.slice(1);

  return `${SUPABASE_PUBLIC_BASE}/${imagePath}`;
}

module.exports = { buildImageUrl };
