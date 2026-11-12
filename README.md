# Barangay Sugod Baby Vaccine Monitoring System

Node.js, Express, EJS, and MongoDB application for monthly baby vaccination monitoring.

## Separate portal sign-in pages

- Portal selection: `/login`
- Administrator: `/admin/login` → `/admin/dashboard`
- Healthcare Worker: `/healthcare/login` → `/healthcare/dashboard`
- Parent/Guardian: `/parent/login` → `/parent/dashboard` (redirects to `/my-babies`)
- Parent registration: `/register`

The login handler checks the account role on the server. An account cannot sign in through a different role's portal. Administrator and Healthcare Worker have separate dashboard views; parents see only babies linked to their account.

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Set `MONGODB_URI`, a long random `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
5. Run `npm start`.
6. Open `http://localhost:3000/login`.

The application connects to MongoDB before it starts listening. The configured administrator is created if it does not exist.

### Reset an existing administrator password

To reset the administrator configured by `ADMIN_EMAIL`, set `ADMIN_RESET_PASSWORD=true` in the environment and restart the application once. The account must already have the `Administrator` role; the app deliberately refuses to convert a Parent or Healthcare Worker account into an administrator. After the log says `Administrator password reset and account activated.`, immediately set `ADMIN_RESET_PASSWORD=false` and restart/redeploy. Do not leave this flag enabled.

## Render deployment

Set these environment variables in the Render Web Service:

- `MONGODB_URI`
- `SESSION_SECRET`
- `ADMIN_NAME`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ADMIN_RESET_PASSWORD` (normally `false`; only set `true` for a one-time reset)

Keep `.env` private and never upload it to GitHub. The Express app trusts one reverse proxy hop for Render's forwarded client IP header and rate limiter.

## Account setup

- Administrator account is initialized from the environment variables.
- Administrator creates Healthcare Worker accounts from **User accounts**.
- Parents register from **Parent registration**. A Healthcare Worker links the parent's account to a baby record using the parent's email.

## Safety and data

Do not delete MongoDB collections to troubleshoot sign-in. Baby and vaccination records are stored separately from user authentication. Back up the database before maintenance. Use unique passwords and rotate any credentials accidentally committed or shared.

## Session cookie configuration (localhost and Render)

The session cookie uses `secure: "auto"` and the app trusts one reverse proxy.
This allows the session cookie over HTTP on localhost while requiring a secure
cookie when the app is accessed over HTTPS on Render. If login succeeds but the
browser returns to the portal selector, restart the server and clear cookies for
`localhost:3000`, then sign in again.
