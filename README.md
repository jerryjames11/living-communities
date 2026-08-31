# Living Communities

Home-services marketplace connecting homeowners with local, verified providers.
Plain Node.js (no framework) serving both the API and the static frontend from one process.

## Run locally

    npm start
    # → http://localhost:3000

First run auto-seeds `data.json` (gitignored) with demo accounts:

- Homeowner: `homeowner@livingcommunities.test` / `Homeowner123!`
- Provider: `provider@livingcommunities.test` / `Provider123!`
- Provider 2: `provider2@livingcommunities.test` / `Provider123!`

## Notes for going live

See the recommendations shared with the project for the current state,
what was fixed, and the path to a low-cost production deployment
(persistent database, hosting, env vars, HTTPS).
