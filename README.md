# Ayame

Ayame is a private, self-hosted personal knowledge hub for organizing notes, Markdown vaults,
and other personal information in one central place.

It is designed to act as a second brain while keeping the user's knowledge under their own control.

```text
frontend/ → Vue 3 + Vite + JavaScript
backend/  → Node.js + Fastify + JavaScript
```

Requirements: Node.js 22.12 or newer and npm.

### Configuration

Storage locations are configured via environment variables:

- `AYAME_DATABASE_PATH`: path to SQLite database (default: `data/ayame.sqlite`).
- `AYAME_VAULTS_PATH`: path to vaults root directory (default: `data/vaults`).

Install dependencies:

```sh
npm install
```

Run the frontend at http://localhost:5173:

```sh
npm run dev:frontend
```

Run the backend at http://127.0.0.1:3000 in another terminal:

```sh
npm run start:backend
```

Build the frontend into `frontend/dist/`:

```sh
npm run build
```

### Routing and SPA Fallback

The frontend uses Vue Router 4 with HTML5 History (`createWebHistory()`) for `/` and `/vault/:directory` (with `?note=<vault-relative-path>`). During development, `npm run dev:frontend` handles SPA fallback automatically while proxying API requests. When serving the compiled `frontend/dist/` bundle in production, configure the web server or reverse proxy to:

- Forward `/auth/*` and `/vaults/*` directly to the Fastify backend (`http://127.0.0.1:3000`) without rewriting them to `index.html`.
- Serve static assets from `frontend/dist/` when they exist, and fall back to `frontend/dist/index.html` for application routes (such as `/` and `/vault/*`).

Run the backend tests:

```sh
npm test
```

### Editing Markdown notes

Ayame edits existing `.md` and `.markdown` files in place through a same-directory temporary file and replacement rename. Each read returns a SHA-256 revision of the exact file bytes; saves reject stale revisions and serialize Ayame writers with an adjacent lockfile such as `.note.md.ayame.lock`.

Ayame never steals an existing lock automatically. If a process is terminated while holding one, stop every Ayame process that can access that vault, confirm no save is active, then remove only the abandoned lockfile and any matching `.note.md.ayame-<random>.tmp` files for the affected note. The replacement writes and synchronizes the temporary file before rename. Directory synchronization is attempted on Linux and skipped on Windows, so crash durability is not identical across platforms; the existing file mode bits are copied, while ownership and platform ACLs are not preserved by this first version.

The lock assumes the underlying filesystem honors exclusive file creation; network filesystem behavior has not been verified. It coordinates Ayame processes only. External editors do not honor it, and Node's portable path APIs cannot atomically combine ancestor validation, revision comparison, and replacement. Ayame rechecks the path and revision immediately before replacement, but an external process can still race that final check.
