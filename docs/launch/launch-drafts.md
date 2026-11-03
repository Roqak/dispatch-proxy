# Launch drafts

Ready-to-post launch copy. Replace [placeholder] after publishing; edit freely.

---

## Hacker News (Show HN)

Title: `Show HN: Dispatch – a lightweight, native, open-source API client (works with Postman)`

> Hi HN! I built Dispatch, a native API client (mac/Windows/Linux) that syncs with your existing Postman account through Postman's official API — so your team can keep working in Postman while you use something about 200x smaller.
>
> Numbers from our bench (both apps idle, same box, no GPU): Dispatch 2.6 MB installed (.deb reuses your system WebKitGTK; the self-contained AppImage is 249 MB) vs Postman's 539 MB; 3 processes vs 14; ~520 MB RSS vs ~875 MB; ~1.3% vs ~8.4% CPU of one core. Full methodology is in the README: [GITHUB_URL]
>
> What it does: two-way sync of workspaces, collections, environments and globals via your own API key (with conflict detection before overwriting teammates), Postman-compatible `pm` scripting (real bundled chai/crypto-js/lodash), AWS SigV4/Digest/Hawk auth, client certificates, proxies, a collection runner with CSV/JSON data files, cURL in/out, tabs, history, profiles for multiple Postman accounts — and it works entirely offline with a local workspace and no Postman account at all.
>
> Why build this instead of Bruno/Yaak? Those are great, but they treat Postman as a place to migrate away from — export once, live in Git. Dispatch's bet is the opposite: your team stays in Postman, and you get a fast, tiny client that talks to the same cloud source of truth. Installers: [RELEASE_URL]. Open source, Tauri + Rust + plain JS (no build step for the UI).

Note: post with the repo URL, not the release page. Good timing weekdays 8–10am US eastern.

---

## Reddit — r/webdev / r/commandline / r/rust

Title: `Dispatch: open-source API client, 2.6 MB installed, live-syncs your team's Postman (unlike Bruno/Yaak which require everyone to migrate)`

> Body: I got tired of the Postman desktop app eating ~900 MB of RAM for what I actually do: send requests against collections my team keeps in Postman. So I built Dispatch. It syncs your Postman workspaces/collections/environments through the official API (your own key, 2–3 calls per save), detects conflicts before pushing, and runs `pm` scripts — with a collection runner, multiple account profiles, AWS/Digest/Hawk auth, client certs and proxy support.
>
> Fully offline "local profile" included: no Postman account needed. macOS (13+), Windows, Linux. GitHub: [GITHUB_URL]. Benchmarks vs Postman measured on the same machine: [anchor to README section].

---

## Bruno / Hacker-companion positioning (comment, for relevant threads)

> Dispatch takes the opposite bet to Bruno: the team's source of truth stays in Postman's cloud (official API, your own key), so Postman users don't have to migrate — you just stop running the 539 MB desktop build. Two-way sync, conflict detection before overwriting, and a real test runner. [GITHUB_URL]