# dispatch-server

An optional, self-hostable backend for [Dispatch](../): it holds **one Postman API key** and serves multiple users through it, with authentication, roles and per-workspace access control. One binary, SQLite, no external services. If you'd rather use your own Postman key per person, keep Dispatch standalone — the server is entirely optional.

> Prefer Cloudflare? [worker/](../worker/) deploys the same API to a Cloudflare Worker (D1 database, same admin panel) with `npx wrangler deploy`.

## The idea

You keep one Postman account (yours) and run `dispatch-server` somewhere. Users point Dispatch at your server URL, sign in, and work with your Postman workspaces, collections and environments through your account — without ever seeing the API key. You decide who can do what:

- **viewer** — read-only. Private ("current") variable values are stripped, so viewers never receive secrets.
- **editor** — read/write collections, environments, folders and requests in their workspaces.
- **creator** — everything an editor can do, plus **create** collections (and mocks, monitors, APIs, schemas).
- **admin** — everything, including **deleting** collections/environments and administering the server.

## Run it

```sh
cargo build --release
POSTMAN_API_KEY=PMAK-xxx ./target/release/dispatch-server
```

Prebuilt binaries (`dispatch-server-linux-x64`, `dispatch-server-macos-arm64/x64`, `dispatch-server-windows-x64.exe`) are attached to every [GitHub release](https://github.com/Roqak/dispatch/releases) — download, set `POSTMAN_API_KEY`, run. The deploy buttons below build from source themselves; nothing there depends on the release.

The server listens on `127.0.0.1:8383` by default; users open Dispatch → Settings → Profiles → **Add profile** → *Dispatch server*, enter the URL and their email/password (or a pre-issued token), and everything else works like a Postman profile. The web admin panel is at `http://<host>:<port>/admin/`.

### Containers and clouds

The binary ships as a container (`server/Dockerfile`, context `./server`, SQLite volume at `/data`):

```sh
docker build -t dispatch-server ./server
docker run -p 8383:8383 -e POSTMAN_API_KEY=PMAK-xxx -v dispatch-data:/data dispatch-server
```

Render: use the **Deploy to Render** button in the top-level README — [`render.yaml`](../render.yaml) defines the service with a 1 GB disk at `/data` and prompts for the Postman key (disks need a paid instance plan). Railway: same image, see [`docs/deploy-railway.md`](../docs/deploy-railway.md). On PaaS the server binds `0.0.0.0:$PORT` automatically when the platform sets `PORT`.

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `POSTMAN_API_KEY` | — | The one Postman account's key. Without it the server boots, but proxying answers 503. |
| `POSTMAN_REGION` | `us` | `us` or `eu` (Postman hosts EU accounts separately). |
| `POSTMAN_API_BASE` | — | Override the Postman base URL (useful for tests). |
| `LISTEN_ADDR` | `127.0.0.1:8383` | Address to bind. |
| `DB_PATH` | `./dispatch-server.db` | SQLite database (users, tokens, settings, audit log). |
| `REQUIRE_AUTH` | `true` | Enforce accounts (register/login). With `false` the proxy is open to anyone who can reach it — bind accordingly. |
| `ADMIN_PASSWORD` | — | Required in `REQUIRE_AUTH=false` mode to unlock the admin panel (`POST /auth/admin-login`); if unset, one is generated and printed at boot. |

## Auth modes

- **Enforced (default).** Registration is open until you turn it off in the admin panel. The **first registered user becomes admin**. Users log in with email + password; the desktop client stores the session token.
- **Open (`REQUIRE_AUTH=false`).** Everything reachable is proxyable without an account, with editor-like access. Useful on a trusted LAN; the admin panel still needs `ADMIN_PASSWORD`.

## Admin panel

`/admin/` — manage users (create, change role and **workspace grants**, reset password, delete), toggle registration, and view the audit log. Workspace grants: empty means *all workspaces*; otherwise a comma-separated list of Postman workspace IDs limits the user to those.

## How enforcement works

Requests mirror Postman's API paths, so the desktop client uses the server URL in place of Postman's. The checked requests follow:

- Only documented Postman endpoints are reachable.
- Roles and workspace grants are checked before anything is forwarded; lists are filtered per grant.
- Creation is pinned to one of the user's granted workspaces.
- Collection/environment deletions are admin-only.
- Viewers receive shared variable values only; private `currentValue`s are removed.
- Postman responses (successes and errors) and the `x-ratelimit-remaining-month` header are passed through unchanged, so the client renders them exactly as it does Postman.
- Every proxied call is recorded in the audit log — including who did what.

## Honest limits

- Access control is at workspace/collection/environment granularity, not per-request.
- "Current values" of variables are shared by all server users with editor+ in that workspace — that's inherent to one shared Postman account.
- Postman's API rate limits attach to the single key; the server caches list reads for 60 seconds, but heavy use is still one quota.
- Writes by different users are indistinguishable to Postman itself; attribution lives in the server's audit log.
- Sharing one Postman account across a team isn't Postman's intended model — self-hosting and audit are the mitigations; evaluate your own terms.