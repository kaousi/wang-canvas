# Wang Local

Local wrapper for the Wang canvas frontend snapshot. It serves the bundled frontend from `wang-local/`, mocks or proxies backend APIs, and can send image requests to an OpenAI-compatible endpoint when configured locally.

## Run

```bash
cd wang-local
npm install
npm run dev
```

Then open:

```text
http://localhost:3456/workflow?workspaceId=demo
```

## Configuration

Copy `wang-local/config.example.json` to `wang-local/config.json` and fill in local API settings. `config.json` is intentionally ignored by Git because it may contain API keys.

If `config.json` is missing, the server now starts with safe mock defaults.

## Backup Notes

The Git backup excludes local generated media, session state, dependencies, Playwright traces, and API keys. See `PROJECT_AUDIT.md` for the current completion and cleanup audit.
