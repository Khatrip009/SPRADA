require('dotenv').config();
const webpush = require('web-push');

try {
  webpush.setVapidDetails('mailto:admin@example.com', process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  console.log('VAPID keys OK');
} catch (err) {
  console.error('VAPID keys invalid:', err && err.message);
  process.exit(1);
}
