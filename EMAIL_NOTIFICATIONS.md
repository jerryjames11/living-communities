# Email Notifications

Every email the app can send, by who receives it. "Live" means the code already sends it (see `server.js`, search for `sendEmail(`). "Suggested" means it doesn't exist yet — just an idea for later.

Emails are sent via Resend (`RESEND_API_KEY`). Without that key set, sends are logged as dry runs instead of actually delivered — useful for local dev.

**From address:** every email is sent as `EMAIL_FROM`, which defaults to `Living Communities <onboarding@resend.dev>` — Resend's shared test address. Until you verify your own domain with Resend (free, at resend.com/domains), `onboarding@resend.dev` can only deliver to the email on your own Resend account; every other recipient silently fails. Set `EMAIL_FROM` to an address at your verified domain (e.g. `Living Communities <hello@yourdomain.com>`) before this goes live for real users. See `.env.example`.

**Admin alerts** all go to `ADMIN_NOTIFY_EMAIL` (falls back to `ADMIN_EMAIL` if unset, so they work with zero extra config). The daily digest needs an external cron/pinger hitting `POST /api/internal/run-admin-digest` with header `x-internal-key: <INTERNAL_JOB_KEY>` — same pattern as the existing billing check job. See `.env.example`.

**Home Care Plan pricing:** every service is now priced by an admin after a home visit or consultation, not a flat catalog rate. A homeowner requesting a service just puts it on their radar (no charge, no card needed) until an admin sets a price and the homeowner accepts it — that's the only point billing starts.

## Homeowner

| Email | Trigger |
|---|---|
| Welcome | Account created |
| New quote | A provider quoted their request |
| Job completed | Provider marked a job done — prompts them to leave a review |
| Job cancelled | Either party cancelled a scheduled job |
| New message | Anyone messages them |
| Account suspended | Admin suspends their account |
| Account reactivated | Admin reactivates their account |
| Community plan changed | They change their own plan (Free/Plus/Premium) |
| Community plan invoice | Admin upgrades their plan for them |
| Community plan renewed | Card charged on the monthly renewal |
| Care plan request received | They request a recurring service — pricing follows a visit |
| Care plan quote ready | Admin sets a price after the visit — nothing's billed until accepted |
| Care plan service activated | They accept a quote — billing starts (or grows) |
| Care plan service removed | A single service is dropped (still have others on the plan) |
| Care plan cancelled | They drop to zero recurring services |
| Care plan renewal reminder | 7 days before the next Care Plan charge — itemized, service by service |
| Care plan charged | Card charged for the Care Plan — itemized, service by service |
| Payment failed | A card charge didn't go through |

## Service Provider

| Email | Trigger |
|---|---|
| Welcome | Account created |
| Quote accepted | Homeowner accepted their quote — they got the job |
| New review | A homeowner reviewed them |
| Job cancelled | Either party cancelled a scheduled job |
| New message | Anyone messages them |
| Account suspended | Admin suspends their account |
| Account reactivated | Admin reactivates their account |
| Verification submitted | Confirms their documents were received |
| Verification approved | Admin approved their verification |
| Verification rejected | Admin rejected it, with notes on what to fix |
| Provider plan changed | They switch their own plan (Free/Pro) |
| Provider plan invoice | Admin upgrades their plan for them |
| Pro plan renewed | Card charged on the monthly renewal |
| Payment failed | A card charge didn't go through |
| Dispatched to a request | Admin manually connected them to a stale request |
| Assigned a Care Plan service | Admin assigned them to a homeowner's recurring service |

## Admin

All require `ADMIN_NOTIFY_EMAIL` (or `ADMIN_EMAIL`) to be set — see above.

| Email | Trigger |
|---|---|
| New homeowner signup | A homeowner registers |
| New provider signup | A provider registers |
| New verification pending | A provider submitted documents and needs review |
| Care plan pricing needed | A homeowner requested a recurring service and it needs a price after a visit |
| Background check requested | A provider opts into a background check (still a manual follow-up — no vendor wired up) |
| Plan cancelled (churn) | A homeowner or provider downgrades their own plan to Free |
| Payment failed | Any account's card charge fails (real Stripe billing only) |
| Low-rating review | A review of 2 stars or fewer is posted |
| Job cancelled | A scheduled job gets cancelled |
| Daily digest | Rollup of new signups, open/stale requests, pending verifications, suspended accounts — one email instead of many pings. Needs an external cron hitting `run-admin-digest` (see above) |

All of the above are live.
