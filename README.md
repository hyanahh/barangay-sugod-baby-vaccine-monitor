# Barangay Sugod Baby Vaccine Monitoring System

Responsive Node.js, Express, EJS, and MongoDB application for monthly baby vaccination monitoring at Barangay Sugod.

## Monthly monitoring workflow
- Dashboard defaults to the current month and allows staff to select another month.
- Monthly totals show registered babies, vaccine records, completed doses, scheduled doses, and missed doses.
- Reports filter records by vaccine date or next due date in the selected month.
- Health workers enter and verify vaccine details and due dates; the system does not generate clinical schedules.

## Parent notifications: TextBee SMS + Web Push
The system supports two independent notification channels. Parents choose SMS consent and enable Web Push separately in Settings.

### TextBee SMS
- Uses the TextBee REST API to send SMS from a paired Android phone and its SIM.
- Free TextBee tier currently advertises one active Android device, up to 50 messages/day and 300 messages/month; provider plan limits may change.
- The phone must be online, TextBee app paired to the account, and SMS permissions granted.
- The SMS is sent using the phone's own SIM and phone number. Carrier/SIM charges, prepaid load requirements, fair-use policies, and local SMS limits may still apply; this is not guaranteed to be zero-cost carrier SMS.
- SMS is sent only to linked, active parent accounts that explicitly opted in and supplied a valid Philippine mobile number.
- Vaccine record notification includes the baby name, vaccine name, and next due date. In-app message alerts contain only a generic alert, not the private message text.

Configure TextBee:
1. Create a TextBee account and install its Android app on the dedicated gateway phone (Android 7+).
2. Pair the phone in the TextBee dashboard and confirm the device is online and allowed to send SMS.
3. Create an API key in the TextBee dashboard.
4. Add `TEXTBEE_API_KEY` to local `.env` and Render Environment. Keep `TEXTBEE_BASE_URL=https://api.textbee.dev/api/v1` unless TextBee changes its API base URL.
5. Parent/guardian enters their phone number and opts into SMS under Settings.
6. Test with a consenting test number and check TextBee message history. An accepted API request does not guarantee handset delivery.

### Web Push notifications
- Browser notifications are sent to parent devices that have explicitly enabled Web Push.
- Requires an HTTPS deployment (Render HTTPS works), a supported browser, internet access, and browser permission.
- Each parent device must enable Web Push separately from Settings. A parent can disable it on that device at any time.
- Web Push does not use SMS credits or a mobile SIM. The browser/device may need the site installed or permitted, depending on platform/browser behavior.

Configure Web Push:
1. Run `npm install`.
2. Run `npm run generate-vapid` once. Copy the three generated values into `.env` and Render Environment as `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`.
3. Keep the VAPID private key secret. Do not commit `.env` or paste the private key into client-side code.
4. Deploy/restart the app over HTTPS.
5. Sign in using a parent account, open Settings, and tap **Enable Web Push on this device**. Allow browser notifications when prompted.
6. Repeat on each parent's other devices if they want notifications there too.

### How notifications are triggered
- When a healthcare worker or administrator saves a vaccine record with a next due date, the app notifies linked parent accounts with SMS and/or Web Push enabled.
- When health staff send a parent an in-app message, the parent receives a generic SMS and/or Web Push alert if that channel is enabled.
- If neither channel is enabled, the in-app record/message still saves; no external notification is sent.
- Expired Web Push subscriptions (HTTP 404/410) are removed automatically.

## Included features
- Parent/guardian accounts and linked baby portal
- Baby profiles and monthly vaccination history
- Monthly dashboard and reports
- Barangay field and baby search
- Role-based access: Parent/Guardian, Healthcare Worker, Administrator
- Responsive phone, tablet, and desktop layout
- Stored-message inbox
- TextBee SMS integration with parent consent
- Web Push notifications with per-device subscription
- Administrator account management

## Local setup
1. Install Node.js 20+.
2. Create a MongoDB database.
3. Copy `.env.example` to `.env` and fill in required values.
4. Run `npm install` then `npm start`.
5. Open `http://localhost:3000`. Web Push requires HTTPS; localhost is treated as a secure development origin by supported browsers.
6. The initial administrator is created from `ADMIN_NAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` on first database connection.

## Render deployment
1. Push the project to GitHub.
2. Create a Render Web Service and connect the repository.
3. Build command: `npm install`.
4. Start command: `npm start`.
5. Add required environment variables from `.env.example` in Render. Set `NODE_ENV=production` and `APP_BASE_URL` to the Render HTTPS URL.
6. Add TextBee API key and VAPID keys only if you want to activate those notification channels.

## Privacy, safety, and limitations
- This is a development starter, not a certified health-record system. Use fictional test data until the Barangay Sugod health center approves privacy, security, retention, backup, consent, and access procedures.
- Do not enter real baby health information without authorization and appropriate safeguards.
- SMS/push content is intentionally limited; do not include diagnoses or unnecessary sensitive health details.
- Confirm guardian consent and phone ownership before enabling SMS. Parents can withdraw SMS consent in Settings and disable push on each device.
- TextBee's free plan limits and availability can change. SMS transmission may still use prepaid load or incur normal carrier charges on the Android SIM.
- Web Push requires HTTPS, internet, supported browser/device settings, and permission. It is not an SMS replacement when the device is offline.
- No vaccine schedule is generated. Qualified health workers must validate vaccine names, dates, and due dates against current Department of Health guidance and each child's official record.
- Before real use, add CSRF protection, audit logs, staff verification, admin-approved parent-to-child linking, access reviews, and security testing.
- Restrict MongoDB network access, use strong secrets, enable backups, and never commit `.env` or API keys.

## Branding
The app's displayed name is **Barangay Sugod Baby Vaccine Monitoring System**.
