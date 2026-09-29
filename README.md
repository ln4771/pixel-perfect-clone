# Smart Traffic Management

Adaptive traffic signal control dashboard for Chennai, built with React,
TypeScript, TanStack Start, Vite, Tailwind CSS, Leaflet and Supabase.

## Local development

Use Node.js 22.12+ (or a compatible Bun release).

```sh
bun install --frozen-lockfile
bun run dev
```

Alternatively, use `npm install` and `npm run dev`.

## Environment

Keep the existing Supabase project and database. Browser configuration uses
`VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Server configuration
uses `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`; privileged traffic updates
also require `SUPABASE_SERVICE_ROLE_KEY`, as configured
in `src/integrations/supabase/client.server.ts`.
Keep privileged keys in the server environment only.

Browser sessions persist in local storage and automatically refresh. Editor
iframe session sharing is no longer used.

The optional cron authentication helper uses `CRON_SECRET` and
`CRON_SECRET_PREVIOUS`. If you use that helper outside this repository, copy
existing scheduler secret values into these names before deploying. No current
route imports the helper.

## Build and deployment

```sh
bun run build
```

The explicit Vite configuration retains the custom SSR entry (`src/server.ts`),
Tailwind, React, path aliases, and a Cloudflare Workers build target through
Nitro. Set `NITRO_PRESET` for another deployment target. For Node hosting, set
`NITRO_PRESET=node-server`, build, then run `node .output/server/index.mjs`.
Configure the same Supabase environment variables on the hosting service.

## Project structure

- `src/components/traffic`: dashboard panels, maps, charts and camera views.
- `src/lib/traffic-model.ts`: adaptive signal calculations.
- `src/lib/traffic.functions.ts`: server functions for traffic updates.
- `supabase/migrations`: existing database schema and migrations.
- `docs/plans`: preserved project planning notes.

## Validation

Run `bun run build` and `bun run lint` after installing dependencies.
The cleanup preserves dashboard components, styling, traffic models and database
migrations byte-for-byte. Dependency installation and a full build could not be
run in the editing environment because package-registry access was unavailable.
Before deployment, verify live data, signal updates, camera views and maps with
your existing server environment.
