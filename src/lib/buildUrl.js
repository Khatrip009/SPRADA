// src/lib/buildUrl.js

const SUPABASE_PROJECT =
  process.env.SUPABASE_PROJECT_REF || 'kwthxsumqqssiywdcevx';

const SUPABASE_BUCKET =
  process.env.SUPABASE_STORAGE_BUCKET || 'sprada_storage';

const SUPABASE_PUBLIC_BASE =
  `https://${SUPABASE_PROJECT}.supabase.co/storage/v1/object/public/${SUPABASE_BUCKET}`;

function buildImageUrl(imagePath) {
  if (!imagePath) return null;

  // Already absolute → trust it
  if (/^https?:\/\//i.test(imagePath)) return imagePath;

  // Normalize path
  const clean = imagePath.replace(/^\/+/, '');

  return `${SUPABASE_PUBLIC_BASE}/${clean}`;
}

module.exports = { buildImageUrl };
