# Project Audit

Date: 2026-07-05

## Current Shape

This project is not a normal source checkout. It is a saved production frontend bundle plus a local Node/Express adapter in `wang-local/`.

The runnable project is `wang-local/`:

- `server.js`: local API adapter, proxy, generation handling, local canvas/session/material storage.
- `index.html` and `assets/`: bundled frontend assets used by the local server.
- `auth-mock.js` and `settings-ui.js`: browser-side local patches.
- `package.json` and `package-lock.json`: Node runtime dependencies.

## Implemented Or Mostly Working

- Local workflow page serving at `/workflow?workspaceId=demo`.
- OpenAI-compatible image generation settings, including multiple profiles and streaming toggle.
- Pose reference and camera angle image-to-image flows using the image-generation path.
- Local generation history and asset/material library storage.
- My assets/material selector endpoints:
  - `/agent/story-canvas/query-user-assets`
  - `/agent/story-canvas/query-asset-categories`
  - `/agent/story-canvas/add-canvas-asset`
  - `/agent/story-canvas/update-canvas-asset`
  - `/agent/story-canvas/delete-canvas-asset`
- Local generated media upload/storage through `/generated` and `/dify`.

## Still Incomplete Or Mocked

These areas are intentionally mocked, removed, or only partially backed by local data:

- Membership, billing, coupons, recharge, invoices, gift cards, enterprise levels.
- Community/product/video showcase modules.
- Competition activity modules.
- AI shot chapter/storyboard backend data beyond local canvas basics.
- Real notification, invite-code, active-session, operation-log, and project-point systems.
- World model configs/generation are placeholder responses.
- Audio, music, lyrics, lip-sync, video render, CapCut export, and some upscale/video workflows are placeholders unless the frontend only needs a task id.
- Template marketplace/list/detail endpoints return empty local data.
- The final catch-all API route still returns `success: true` with empty data for unknown `/api`, `/user`, `/agent`, and `/ucenter` routes. This keeps the frontend from crashing but can hide missing backend behavior.

## Redundant Or Local-Only Files

These should not be backed up to GitHub:

- `.playwright-mcp/`: test screenshots, YAML snapshots, console logs.
- `.venv/`: local Python virtual environment.
- `.vite/`: local Vite cache.
- `.DS_Store`: macOS metadata.
- `page-screenshot.png`, `page-snapshot.md`, `page-text.txt`: temporary inspection artifacts.
- `wang-local/node_modules/`: installable dependencies.
- `wang-local/tmp/`: upload temp directory.
- `wang-local/generated/`: local sessions, uploaded images, generated images, thumbnails.
- `wang-local/config.json`: local secrets and API endpoint configuration.
- `Wang - ...html` and `Wang - ..._files/`: original browser-saved snapshot. It is redundant for backup because the runnable local copy is under `wang-local/`. It also contains extra third-party page-save artifacts such as captcha scripts and favicon resources.

## Cleanup Done

- Added `.gitignore` to exclude local artifacts, generated media, dependencies, and secrets from backup.
- Added `wang-local/config.example.json`.
- Changed `server.js` so missing `config.json` no longer prevents startup.
- Verified `server.js` with `node --check`.

## Backup Policy

The GitHub backup should include source/runtime files only. It should not include generated user media, local sessions, installed dependencies, Playwright traces, or API keys.
