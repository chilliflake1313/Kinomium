# Medium Capture Pipeline Documentation

## Purpose
This project captures a Medium article through ArchiveBox and renders the captured page inside your local app UI.

## High-Level Architecture
Frontend (Load button) -> Node backend (/capture) -> ArchiveBox add -> Snapshot stored in archive-data -> Backend reads snapshot HTML -> Frontend iframe renders page.

## Folder Overview
- `server.js`: Backend route and capture orchestration.
- `public/index.html`: UI with URL input, Load button, iframe, and status text.
- `docker-compose.yml`: ArchiveBox service definition.
- `archive-data/`: ArchiveBox data directory (snapshots, metadata, assets).

## Runtime Pipeline (Exact Flow)
1. User opens `http://localhost:3000`.
2. User pastes a Medium URL and clicks **Load**.
3. Frontend sets iframe source to `/capture?url=<encoded>&_=<timestamp>`.
4. Backend route `/capture` validates the URL contains `medium.com`.
5. Backend runs:
   - `docker compose exec --user=archivebox -T archivebox archivebox add --depth=0 <url>`
6. ArchiveBox writes/updates snapshot metadata and files under `archive-data/archive/<folder>/`.
7. Backend waits briefly, then resolves the matching snapshot folder for the requested URL.
8. Backend selects the best renderable file in priority order:
   - `output.html`
   - `singlefile.html`
   - `readability/content.html`
   - `medium.com`
   - `index.html`
9. Backend reads that file from disk and sends HTML directly as response.
10. Iframe loads response HTML and shows the captured Medium page.

## Why It Now Shows the Page Directly
Older behavior redirected to ArchiveBox index pages (`.../index.html`), which showed the ArchiveBox snapshot dashboard.

Current behavior returns the captured article HTML directly from the backend (`res.send(html)`), so the iframe displays the actual page content.

## Key Backend Logic
### URL normalization and matching
The backend matches snapshots using:
- normalized URL comparison
- decoded URL comparison
- Medium article ID suffix fallback
- ArchiveBox metadata fields including `base_url`

This prevents loading the wrong historical snapshot.

### Cache behavior
The `/capture` route sets no-cache headers and frontend adds a timestamp query value (`_=`). This avoids stale browser reuse of old failed responses.

## Start and Run
1. Start ArchiveBox:
   - `docker compose up -d`
2. Start app:
   - `npm start`
3. Open:
   - `http://localhost:3000`
4. Paste Medium URL and click **Load**.

## Common Issues and Fixes
### "Capture failed"
Usually means ArchiveBox command failed. Check:
- Docker is running
- ArchiveBox container is up
- Command runs from project directory containing `docker-compose.yml`

### Wrong page appears
Usually from stale server process or stale browser cache.

Fix:
- Stop all node processes and start one server instance
- Keep cache-busting query and no-cache headers enabled

### ArchiveBox dashboard appears instead of article
This means the chosen file was snapshot `index.html` (dashboard) instead of article output.

Current selection order prefers direct article files (`output.html`, `singlefile.html`) first.

## Notes
- This is a local capture viewer for archived content.
- Archive quality can vary by article and extractor availability.
- Some console warnings inside archived pages are expected and harmless.
