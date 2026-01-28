/* ===================== README.md ===================== */
# Exotech Sprada Backend (Express) - Updated Scaffold


## Quick start
1. Copy files into a new project folder.
2. `cp .env.example .env` and edit values (especially DATABASE_URL, JWT_SECRET, S3 keys, REDIS_URL).
3. `npm install`
4. Run DB migrations: `npm run migrate` (puts migration SQL in ./migrations)
5. Start dev server: `npm run dev` (listens on PORT, default 4200)
6. Start worker in another terminal: `npm run worker`


## What I added
- Full JWT auth with access & refresh tokens (refresh tokens stored hashed in the DB). Refresh route rotates tokens.
- Middleware `jwtAuthMiddleware` that parses Authorization header and attaches `req.user`.
- Transaction middleware `req.txRun(fn)` automatically sets `app.user_id` and `app.user_role` based on `req.user` in the same DB transaction (uses SET LOCAL).
- BullMQ worker scaffold for notifications + image processing; uses Redis configured by REDIS_URL.
- Migration to create `refresh_tokens` table.


## Notes
- Replace 'change_this_app_password' and other secrets before production.
- You must run the migration that creates `refresh_tokens` (migrations/0002_refresh_tokens.sql).
- The worker currently sends notifications to all subscriptions; refine target_query logic for production.
- For image processing, implement S3 download/upload + `sharp` transforms in the image worker.