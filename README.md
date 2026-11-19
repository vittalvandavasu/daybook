# Daybook

A private time and billing tracker for Mallik and Vittal. The website runs as static HTML, CSS and JavaScript. Supabase owns identity, session state, timestamps and billing calculations.

## Deploy this configured project on Netlify

Daybook already uses the provisioned Supabase project dtziqeojgmiwemmstyju. For manual deployment, extract daybook-netlify.zip and drop the directory containing index.html into Netlify Drop. For a repository deployment, use the tracker directory with the included netlify.toml. Email and password sign-in works directly against Supabase.

## Reference setup for a fresh project

1. Create a Supabase project. In Authentication settings, disable **Allow new users to sign up** and anonymous sign-ins. Enable the email/password provider. Leave other identity providers disabled.
2. Run the complete `migration.sql` once in the SQL Editor of a fresh project. It creates the tables, access policies, authenticated RPCs and Realtime publication entries in one transaction.
3. In Authentication → Users, choose **Add user → Create new user** for `mallik.fico@gmail.com` and `vittalvandavasu16@gmail.com`. Set separate strong passwords and confirm the email addresses when creating the accounts. Supply passwords privately. The migration also picks up matching accounts that already exist.
4. Edit `public/config.js` with the project's HTTPS URL and **publishable** key (a legacy **anon** key also works). Keep administrative and service-role keys out of the website.
5. Deploy the tracker directory as a Netlify project. The included `netlify.toml` selects `public` as the publish directory. Leave the build command empty. For manual drag-and-drop deployment, upload only the contents of `public`. In Supabase Authentication URL Configuration, set Site URL to the final HTTPS site address.
6. Sign in separately as each member. In Settings, enter that person's hourly rate and currency. The initial rate is zero INR. Each member manages their own rate. Check the other member's panel in a second browser while starting, pausing, resuming and stopping a session.

For a local preview, serve `public` with a static HTTP server, for example `python -m http.server 8080 --directory public`, then open http://localhost:8080. Use HTTPS for any remote deployment.

## How billing works

Every action is one database transaction. A unique index permits one open session per member. Mutations lock the member's profile and require a matching session revision. A stale tab or duplicate request cannot advance the same revision twice. The browser reads the saved state again after reconnecting.

The timeline records alternating work and break starts, at whole-second precision. Clock-out supplies the final boundary. Working seconds equal elapsed seconds less all break seconds. By default each working second is billable. If an increment is configured, clock-out rounds the total billable duration up to the next multiple of the increment. A session snapshots the rate, currency and increment when it closes. An open session uses the member's current settings for estimates.

Reports split time at midnight in Asia/Kolkata. Completed sessions count on the date of clock-out. Any extra billable seconds from an increment also belong to that date. Daily charges use differences between cumulative amounts rounded to two decimals, so a multi-day session reconciles to its final charge. Different currencies must be reported separately.

Owners can correct a timeline or enter a forgotten end time with a reason. The database checks ordering, membership, ownership, future timestamps and overlapping sessions. Each successful action writes an audit entry. Corrections retain both versions and the original billing terms of an already closed session. Unfinished sessions stay open until their owner acts.

## Operations

Use Supabase database backups appropriate for your plan. Apply the initial migration to an empty schema once. Subsequent production schema changes should use separate reviewed migrations. To replace an account or change a member's email, coordinate the identity change with the database administrator, since access requires a matching account ID and approved email. Keep the Supabase project and the Netlify deployment under accounts you control.

## Verification

From the `tests` directory, run `npm install` followed by `npm test`. This development-only suite applies the migration to in-memory PostgreSQL using PGlite and substitutes local identities for Supabase Auth. It exercises both members, multiple breaks, stale requests, private access, correction history, rate snapshots and cross-midnight bills. It uses synthetic data in memory only.

Browser checks also exercised the packaged client in Edge with local test authentication and RPC requests backed by the migration. Before launch, verify password sign-in and live updates between two authenticated browsers on your configured Supabase project.

The production client bundles the official `@supabase/supabase-js` 2.119.1 UMD distribution with its license under `public/vendor`.

