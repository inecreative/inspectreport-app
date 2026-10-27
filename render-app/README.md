# InspectReport AI — standalone web app

Photo + short field notes → an AI-structured home-inspection report with
severity badges, repair-cost estimates, and a downloadable PDF.
Built for US home inspectors. Flat **$49/mo** per account.

This is a standard Node.js app (Express + PostgreSQL) that deploys to
[Render](https://render.com) with the included `render.yaml` Blueprint.
No build step — Render runs `npm install` then `npm start`.

---

## What it does

- **Accounts** — email + password sign-up / sign-in (hashed passwords,
  session cookies). Every report belongs to its owner; users only ever
  see their own data.
- **Reports** — create / open / delete inspection reports.
- **Property & Client** — address, client name/email/phone, inspection
  date, inspector name, plus **custom fields** (e.g. Gate code, HOA).
  Custom fields can be saved as **templates** and re-added to any report,
  edited, or deleted.
- **Photos** — upload job-site photos (JPEG/PNG/WebP/GIF, up to 10 MB
  each), optionally attached to a specific finding.
- **Findings** — add manually, or paste rough field notes and hit
  **AI Structure notes** to turn them into findings with area, title,
  detail, severity (Good / Monitor / Repair / Urgent) and an estimated
  repair cost. Each finding can be edited, polished with AI, or deleted.
- **Stats** — findings count, urgent count, total estimated repair cost,
  and a completeness indicator.
- **Live preview** — the report document renders under the editor as you
  work, and **Download PDF** (always visible in the header) generates a
  real PDF in the browser — header, property/client table incl. custom
  fields, summary, findings with photos — named after the property address.
- **Load sample job** — one click fills a complete sample report
  (4 findings, 2 urgent, $1,590 estimated repairs) so new users can try
  everything immediately.
- **Billing card** — shows the $49/mo plan; the Subscribe button links to
  your Stripe Payment Link (see `PAYMENT_LINK_URL` below). Until that is
  set, the button is disabled with an explanatory note.
- **AI is optional** — with no AI key configured, the app uses a built-in
  keyword-based structurer/polisher/summarizer so every feature still works.

---

## Deploy to Render (step by step)

You need: a Render account, this code in a Git repo (GitHub/GitLab), and
about 10 minutes.

1. **Create a Render account** at <https://render.com> (free to sign up)
   and connect your GitHub/GitLab account.
2. **Push this folder to a Git repo** (the folder containing
   `render.yaml`, `package.json`, `server/`, `public/`).
3. In the Render dashboard click **New → Blueprint**.
4. Select your repo. Render reads `render.yaml` and proposes:
   - a web service **`inspectreport-ai`** (Starter plan),
   - a Postgres database **`inspectreport-db`** (Basic plan),
   - a 1 GB persistent disk for photo uploads.
   Click **Apply**. The database connection and a session secret are
   wired up automatically.
5. When prompted for the two unsynced env vars, you can leave them blank
   for now and fill them in later under the web service's
   **Environment** tab:
   - `AI_API_KEY` — your OpenAI (or compatible) API key. Optional.
   - `PAYMENT_LINK_URL` — your Stripe Payment Link URL for the $49/mo
     plan. Until set, Subscribe stays disabled.
6. Wait for the first deploy to finish. Open the service URL
   (`https://inspectreport-ai.onrender.com` or similar), create your
   account, and click **Load sample job** to test the full flow.
7. *(Later)* Add a custom domain under the web service's **Settings →
   Custom Domains**.

### What it costs on Render

| Piece                       | Plan         | Price      |
| --------------------------- | ------------ | ---------- |
| Web service                 | Starter      | $7/mo      |
| PostgreSQL database         | Basic 256 MB | $6/mo      |
| Persistent disk (photos)    | 1 GB         | $0.25/mo   |
| **Total**                   |              | **≈ $13.25/mo** |

(Prices as listed by Render when this was written; check the dashboard
for current pricing. The Starter web service stays always-on — no
sleeping — which matters when an inspector opens a report on site.)

### Getting a Stripe Payment Link

In the Stripe dashboard: **Product catalog → create the "InspectReport
AI" product at $49/month recurring → Payment Links → create a link for
that price**. Copy the link URL into `PAYMENT_LINK_URL` on Render and
redeploy (or just save — Render restarts the service automatically).

---

## Run it locally

```bash
npm install
npm start
# → http://localhost:3000
```

With no `DATABASE_URL` set, the app boots on a throwaway in-memory
database (handy for a quick look — everything is forgotten on restart).
For real local development, copy `.env.example` to `.env`, set
`DATABASE_URL` to a local Postgres, and export the vars (or use a tool
like `dotenv-cli`). Tables are created automatically on boot.

## Environment variables

| Variable          | Required | Purpose |
| ----------------- | -------- | ------- |
| `DATABASE_URL`    | Prod     | PostgreSQL connection string. On Render it comes from the linked database. Unset = in-memory demo DB. |
| `SESSION_SECRET`  | Prod     | Long random string protecting sessions. Render generates it. |
| `UPLOAD_DIR`      | Prod     | Where uploaded photos are stored. On Render this is the persistent disk mount (`/var/data/uploads`). Local default: `./uploads`. |
| `PORT`            | No       | Listen port (Render sets this automatically). Default 3000. |
| `AI_API_KEY`      | No       | Enables real AI structuring/polish/summary. Unset = built-in keyword fallback. |
| `AI_API_BASE_URL` | No       | OpenAI-compatible API base. Default `https://api.openai.com/v1`. |
| `AI_MODEL`        | No       | Model name. Default `gpt-4o-mini`. |
| `PAYMENT_LINK_URL`| No       | Stripe Payment Link URL for the $49/mo plan. Unset = Subscribe disabled. |

## Project layout

```
render.yaml          Render Blueprint (web service + Postgres + disk)
server/
  index.js           Express app entry point
  db.js              PostgreSQL layer (schema auto-created on boot)
  auth.js            Password hashing (scrypt) + session cookies
  ai.js              AI provider module + keyword fallback
  routes.js          All JSON API routes
public/
  landing.html       Public marketing landing page, served at /
  landing.css        Landing page styles (same design tokens)
  app.html           Single-page app shell, served at /app
  assets/            Landing page photos (Pexels, free license)
  styles.css         Navy #0F2A3D + amber #D97706 design
  app.js             Frontend logic
  pdf.js             Client-side PDF generation (jsPDF)
```

## Notes & limitations

- Uploaded photos live on the web service's persistent disk and are
  served only to the signed-in owner. Back up the disk if the photos
  matter — a single disk is not a backup strategy.
- The app is single-instance friendly: sessions and data live in
  Postgres, photos on the one disk. Don't scale the web service to
  multiple instances without moving photos to object storage (e.g. S3).
- AI calls use the chat-completions API of any OpenAI-compatible
  provider; the app never sends photos to the AI — only text notes.
