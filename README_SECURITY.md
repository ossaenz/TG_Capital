Security checklist — prevent accidental public exposure

- Purpose: concise steps to ensure no sensitive data (API keys, tokens, exports)

1) Current repository scan
  - I scanned the workspace for common secret patterns. No API secrets or private keys were found in tracked files.

2) What I changed
  - Added `.gitignore` entries to prevent committing `cs_tracker.json`, exported data, `.env`, keys, and common IDE files.

3) OAuth client IDs and public identifiers
  - OAuth Client IDs (like the Google client ID) are not secret and can safely remain in client-side code. Client *secrets* must never be committed.

4) If a secret was committed earlier
  - Rotate the secret immediately (create a new API key / OAuth client secret) — treat repo exposure as compromised.
  - Remove the secret from git history using the BFG Repo-Cleaner or `git filter-repo`. Example (BFG):

    bfg --delete-files YOUR_FILE_WITH_SECRET

  - After cleaning history, force-push and inform collaborators.

5) Best practices going forward
  - Never store secrets in client-side bundles or committed files.
  - Use runtime environment secrets on servers (not applicable for static GitHub Pages).
  - Keep exports (`cs_tracker.json`) out of the repo — use Drive appData or local downloads.

6) Next steps I recommend
  - Confirm you want the Google OAuth client ID removed from the repo (it's safe to keep).
  - If you previously committed an exported JSON containing personal data, rotate any keys referenced and run history-clean.
  - Optionally add a GitHub repository secret and CI step if you later add server-side components.

If you want, I can run a deeper scan for accidental secrets (long hex strings, JWTs) and/or remove any files you flag and rewrite history.
