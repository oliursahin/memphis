# morphis

A lightweight, privacy-first email client for Gmail. All your data stays on your machine.

Built with [Tauri](https://tauri.app), [SolidJS](https://www.solidjs.com), and [Tailwind CSS](https://tailwindcss.com).

## Features

- **Keyboard first** — navigate and manage your inbox entirely from the keyboard
- **Inbox splits** — automatically categorize emails into tabs (Important, Calendar, GitHub, Others)
- **Full-text search** — powered by [Tantivy](https://github.com/quickwit-oss/tantivy)
- **Background sync** — continuous sync with Gmail
- **Multiple accounts** — manage several Gmail accounts
- **Local storage** — SQLite database, nothing leaves your device

## Prerequisites

- [Rust](https://rustup.rs) 1.77.2+
- [Node.js](https://nodejs.org) 18+
- Xcode Command Line Tools (macOS): `xcode-select --install`
- Google OAuth credentials ([Google Cloud Console](https://console.cloud.google.com))

## Setup

1. Clone the repo and install dependencies:

```bash
git clone https://github.com/oliursahin/morphis.git
cd morphis
npm install
```

2. Create a `.env` file in the project root:

```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
UNSPLASH_ACCESS_KEY=your-key  # optional, for inbox zero photos
```

3. Run in development:

```bash
npm run tauri:dev
```

4. Build for production:

```bash
npm run tauri:build
```

## Project structure

```
morphis/
├── interface/          # Frontend (SolidJS + TypeScript)
│   ├── pages/          # Inbox, Thread, Compose, Settings, etc.
│   ├── components/     # Sidebar, CommandPalette, SearchPalette, etc.
│   └── styles/         # Global CSS
├── src-tauri/          # Backend (Rust)
│   ├── src/
│   │   ├── commands/   # Tauri IPC command handlers
│   │   ├── db/         # SQLite database layer + migrations
│   │   ├── integrations/gmail/  # OAuth, API client, sync
│   │   ├── email/      # Parsing, sanitization, threading
│   │   ├── search/     # Tantivy full-text search
│   │   └── sync/       # Background sync engine
│   └── migrations/     # SQL schema migrations
├── package.json
├── vite.config.ts
└── index.html
```

## License

[MIT](LICENSE)
