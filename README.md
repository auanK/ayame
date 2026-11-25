# Ayame

![Node.js 22+](https://img.shields.io/badge/Node.js-22.12%2B-339933.svg)
![Vue 3](https://img.shields.io/badge/Vue-3-42b883.svg)
![Fastify](https://img.shields.io/badge/Fastify-5-000000.svg)
![Self-Hosted](https://img.shields.io/badge/Self--Hosted-Plain%20Markdown-7c6fa8.svg)

**A private, self-hosted personal knowledge hub for organizing Markdown vaults in a desktop-style web workspace.**

Built with **Vue 3 + Vite** and **Node.js + Fastify**, Ayame runs directly over ordinary folders of `.md` files on your server — giving you a fast browser workspace with live preview editing, internal links, properties, and an interactive graph while keeping your notes in plain text under your own control.

```text
Browser ─────▶ Ayame (Vue 3 + Fastify) ─────▶ Plain Markdown Vaults on Disk
                                                      ▲
                                                      │  (unencrypted .md files)
                                                      ▼
                                           External Sync Tools & Local Devices
                                           (kasumi, Syncthing, Git, rsync, rclone, etc.)
```

> **Plain-text storage (not encrypted on the server):** Ayame intentionally stores your notes as **unencrypted, plain Markdown files** directly on the server's filesystem (only your account password is hashed with Argon2id in SQLite). This is by design so you can self-host Ayame alongside your preferred file sync tool — such as [kasumi](https://github.com/auanK/kasumi), Syncthing, Git, rsync, or rclone — and keep your vaults seamlessly synchronized with your PC or other devices without vendor lock-in.

---

## Highlights

- **Single-Owner Authentication & Security**: Argon2id password hashing, optional 30-day persistent sessions, sliding-window login rate limiting, and an in-app Account & Security modal for password rotation and revoking other active sessions.
- **Full-Viewport Vaults Hub**: Create vaults directly on disk, organize with drag-and-drop ordering, pin favorites, group by categories, filter by tags or search, set custom accents and cover images, and switch between Cards, Categories, and Compact views.
- **Desktop Markdown Workspace**: CodeMirror 6 Live Preview editor with inline image embeds (`![[image.png]]` and `![alt](path)`), drag/paste image uploads, `[[` wikilink and `#tag` autocomplete, structured YAML frontmatter properties, multi-tab navigation, and resizable Explorer and Context panels.
- **Knowledge Navigation & Graph**: Backlinks, unlinked mentions, outgoing links, document outline, vault-wide tags and full-text search, Daily Notes, Bookmarks, Quick Switcher (`Ctrl/Cmd+O`), Command Palette (`Ctrl/Cmd+P`), vault trash with restore, and an interactive force-directed Global Graph view.
- **Conflict-Aware Atomic Saves**: Every note read returns a SHA-256 content revision; saves reject stale writes, serialize concurrent Ayame writers with an adjacent lockfile, and replace files atomically via temporary file rename.

---

## Quick Start

**Requirements:** Node.js `22.12+` and `npm`.

1. **Install dependencies:**

```bash
npm install
```

2. **Configure storage paths** *(optional — defaults shown below)*:

| Variable | Default | Description |
|---|---|---|
| `AYAME_DATABASE_PATH` | `data/ayame.sqlite` | SQLite database for auth sessions and vault hub metadata |
| `AYAME_VAULTS_PATH` | `data/vaults` | Root directory containing your plain Markdown vault folders |

3. **Run in development** (two terminals):

```bash
npm run start:backend   # Fastify API at http://127.0.0.1:3000
npm run dev:frontend    # Vite app at http://localhost:5173
```

4. **Build & test:**

```bash
npm run build           # Production bundle in frontend/dist/
npm test                # Run backend and frontend test suites
```

---

## Production & File Safety Notes

- **SPA Reverse Proxy**: In production, forward `/auth/*` and `/vaults/*` directly to the Fastify backend (`http://127.0.0.1:3000`), serve existing static files from `frontend/dist/`, and fall back to `frontend/dist/index.html` for application routes (`/` and `/vault/:directory`).
- **Concurrent Editing & Sync**: Ayame uses adjacent lockfiles (`.note.md.ayame.lock`) and SHA-256 revision checks to protect against conflicting saves between Ayame sessions. Because external sync tools and local editors do not honor Ayame's lockfile, Ayame re-verifies the file revision before writing and warns you if a note changed externally. If a process crashes while holding a lock, stop Ayame and remove only the abandoned `.ayame.lock` / `.ayame-*.tmp` files.
