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

Run the backend tests:

```sh
npm test
```
