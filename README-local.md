# Local Testing (Dashboard Focus)

This folder is a local-testing copy of the original `form` project.

## What changed in this copy

- Resend email sending is disabled.
- Form submissions are stored locally in:
  - `netlify/functions/.local-submissions.json`
- Admin dashboard works on localhost without Netlify Identity login.
- `get-submissions` and `delete-submission` use the local JSON store in local mode.

## Run locally

1. Open terminal in `form-local`.
2. Install deps:
   - `npm install`
3. Start Netlify dev:
   - `npx netlify dev`
4. Open:
   - Form: `http://localhost:8888/`
   - Dashboard: `http://localhost:8888/dashboard.html`

## Reset local submissions

Delete this file if you want a fresh dashboard state:

- `netlify/functions/.local-submissions.json`
