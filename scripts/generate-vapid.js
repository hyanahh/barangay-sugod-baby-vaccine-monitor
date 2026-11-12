const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\nAdd these values to your local .env file and Render Environment:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log('VAPID_SUBJECT=mailto:your-admin-email@example.com\n');
