# Deploying dispatch-server to Railway

Railway has no repo-scoped deploy button; one-click deploys go through published **templates** (the mechanism [Listmonk/Vaultwarden](https://railway.com/deploy) use). Two paths:

## One click (via a published template)

Once the maintainer publishes a template, deploy it from that template's URL and skip everything below — Railway provisions the service, the volume, and prompts for the variables.

Publishing it once (maintainer task, ~5 minutes):

1. Sign in to [Railway](https://railway.com), open your workspace → **Templates** → **New Template**.
2. **Add New → GitHub Repo** → pick a fork or this repo.
3. Service **Settings → Root Directory**: `server` (the app and its `Dockerfile` live there; Railway detects the Dockerfile and builds it).
4. **Variables** tab:
   - `POSTMAN_API_KEY` — leave empty; whoever deploys the template fills it in.
   - `DB_PATH` = `/data/dispatch-server.db`
   - `REQUIRE_AUTH` = `true` (`false` instead? also add `ADMIN_PASSWORD` = `${{secret(32)}}`, which generates a random admin password at deploy time)
5. Right-click the service → **Attach Volume** → mount path `/data` (the SQLite database file lives there and survives restarts and redeploys).
6. Right-click the service → **Public Networking** → HTTP (Railway supplies `PORT`; the server binds `0.0.0.0:$PORT` automatically).
7. **Create Template** → copy the template URL into the README's Railway button, optionally publish to the marketplace.

## Manual deploy (no template)

1. New project → **Deploy from GitHub repo** → select your fork of Dispatch.
2. Service settings: **Root Directory** `server`; Railway builds `server/Dockerfile` automatically.
3. Variables: `POSTMAN_API_KEY` (the Postman key), `DB_PATH=/data/dispatch-server.db`.
4. Attach a volume at `/data` — without it, accounts and audit history are lost on every redeploy.
5. **Public Networking → HTTP** to expose the server; the generated `xxx.up.railway.app` URL is what users put into Dispatch (Settings → Profiles → Add profile → **Dispatch server**), and `https://<host>/admin/` is the admin panel.

## Railway-specific notes

- No `railway.json`/`railway.toml` ships here on purpose: Railway's config-as-code is deprecated (legacy files stop working 2026-12-01) and the new `.railway/` IaC is CLI-driven; the Dockerfile + dashboard settings above cover everything a template needs and don't expire.
- Railway builds always run from the service's Root Directory, so the build context is `server/` — the same layout the Render blueprint and plain `docker build ./server` use.
- Health: Railway's default TCP healthcheck is fine; the server answers `/admin/` with HTTP 200 before any auth.
- Free-plan trial credits run out; volumes cost per GB-month. There is no permanent free tier.