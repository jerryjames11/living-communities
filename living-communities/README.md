# Living Communities

Home-services marketplace connecting homeowners with local, verified providers.
Plain Node.js (no framework) serving both the API and the static frontend from one
process, backed by Postgres.

## Run locally

1. Have a Postgres instance running (local install, Docker, or a free Neon/Supabase one).
2. `cp .env.example .env` and fill in `DATABASE_URL`.
3. `npm install`
4. `npm start` → http://localhost:3000

First run creates the tables and seeds demo accounts automatically:

- Homeowner: `homeowner@livingcommunities.test` / `Homeowner123!`
- Provider: `provider@livingcommunities.test` / `Provider123!`
- Provider 2: `provider2@livingcommunities.test` / `Provider123!`

## Going live — step by step (free tier)

**1. Push this project to GitHub.**

    git init
    git add .
    git commit -m "Living Communities"
    # create a new empty repo on github.com, then:
    git remote add origin https://github.com/<you>/living-communities.git
    git push -u origin main

**2. Create a free Postgres database on [neon.tech](https://neon.tech).**
Sign up → New Project → copy the connection string it gives you (starts with
`postgresql://` and ends with `?sslmode=require`). Keep this tab open.

**3. Create a free web service on [render.com](https://render.com).**
Sign up (can use GitHub to sign in) → New → Web Service → connect the GitHub repo
you just pushed. Render will detect `render.yaml` — if it doesn't, set these manually:
   - Build command: `npm install`
   - Start command: `npm start`
   - Plan: Free

**4. Set environment variables** in the Render service's Environment tab:
   - `DATABASE_URL` → paste the Neon connection string from step 2
   - `ALLOWED_ORIGIN` → your Render URL once you have it (e.g. `https://living-communities.onrender.com`), or leave `*` for now and tighten later

**5. Deploy.** Render builds and starts it automatically. First boot creates the
tables and seeds the demo accounts — watch the deploy log for "Seeded demo data."
Your site is live at the `.onrender.com` URL Render gives you.

**6. (Optional) Custom domain.** Buy a domain (Namecheap, Google Domains, etc.),
then in Render → Settings → Custom Domain, follow the DNS instructions it gives you.

### What "free" actually costs you here

- Render's free web service **spins down after 15 minutes of no traffic** and takes
  ~30–60 seconds to wake back up on the next visit. Fine for a demo/beta; upgrade to
  a paid instance ($7/mo) once you have real users who'd bounce on a slow first load.
- Login sessions live in memory, so they reset whenever the service restarts or
  spins down. Users just log in again — no data is lost (that's all in Postgres now).
- Neon's free tier is generous for early traffic and has its own always-on database
  (unaffected by Render sleeping).

### Before real users touch it

- Set `ALLOWED_ORIGIN` to your actual domain instead of `*`.
- Rotate the demo account passwords or remove the seed data (edit `seedIfEmpty` in
  `server.js`, or just delete those three rows from Postgres once you have real users).
- Consider a real email/password-reset flow — there isn't one yet.
