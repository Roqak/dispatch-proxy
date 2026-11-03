# dispatch-server admin panel (placeholder)

A static, vanilla-JS admin panel served by the `dispatch-server` binary at
`/admin/` (the whole directory is embedded into the binary at build time).
Expected files next to this README: `index.html`, `styles.css`, `app.js`.
They may only call the server's own endpoints (`/auth/*`, `/me`, `/admin/*`).