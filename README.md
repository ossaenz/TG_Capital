Capital Stacks Tracker — GitHub Pages + Google Drive setup

This repo is a static single-file app (`index.html`). It uses the Google Identity Services (GIS) + Google Drive API (appDataFolder) to store app state.

Quick goals completed by this repo:
- Client ID is loaded at runtime from `config.json` (not committed).
- `.gitignore` prevents accidental commits of exported data and `config.json`.

Setup steps — Google Cloud (OAuth) and GitHub Pages
1) Create OAuth Client
  - In Google Cloud Console, create an OAuth 2.0 Client ID (Application type: Web application).
  - Add Authorized JavaScript origins for your Pages site:
    - For user pages: `https://<yourusername>.github.io`
    - For project pages: `https://<yourusername>.github.io/<repo>`
  - You do NOT need to expose a client secret for client-side apps.

2) Create `config.json` locally (do NOT commit)
  - At the project root create `config.json` with this content:

    {
      "client_id": "206086068161-os538lqofudoegdmt56up5dnpjsgi3sq.apps.googleusercontent.com"
    }

  - This file is ignored by `.gitignore` and will not be pushed.

3) Verify Drive API is enabled
  - In the Google Cloud Console, enable the Google Drive API for your project.

4) GitHub Pages deployment
  - If you want to publish the app from the `main` branch, enable GitHub Pages in repo Settings → Pages → Source: `main` branch `/ (root)`.
  - For project pages the URL will be `https://<yourusername>.github.io/<repo>`.

5) If you need the client ID available at runtime on GitHub Pages without `config.json`
  - Use a build step (GitHub Actions) that writes `config.json` during deploy from a repo secret.
  - Or host a tiny server to return the client ID (not recommended) — client IDs are public by design.

Security notes
- Client IDs are not secret — Client *secrets* are. This repo no longer contains a client ID in source.
- If you ever commit a secret file, rotate that credential immediately and remove it from git history.

Optional: I can create a GitHub Actions workflow that injects `config.json` from a repository secret at deploy time—ask if you want that.
