'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const { authMiddleware } = require('./auth');
const routes = require('./routes');
const share = require('./share');

const app = express();

app.set('trust proxy', 1); // Render terminates TLS in front of the app.
// Stripe webhooks are verified against the exact raw request bytes, so
// this one route gets a raw body parser BEFORE the global JSON parser
// (body-parser flags the body as read, so express.json() then skips it).
app.use('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'inspectreport-ai', aiEnabled: Boolean(process.env.AI_API_KEY) });
});

app.use('/api', routes);

// Public estimate share pages (Phase 1b): /s/<token> is a read-only
// estimate document a client can view and approve — no login. The
// approve/decline forms post plain form data, hence the urlencoded
// parser scoped to /s (the global JSON parser above skips it).
app.use('/s', express.urlencoded({ extended: false, limit: '16kb' }));
app.get('/s/:token', share.page);
app.post('/s/:token/approve', share.approve);
app.post('/s/:token/decline', share.decline);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Public front door: the marketing landing page lives at /, the app
// itself (with its built-in sign-in view) lives at /app.
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));
app.get('/spectora-alternative', (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'spectora-alternative.html'))
);
app.get('/homegauge-alternative', (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'homegauge-alternative.html'))
);
app.get('/inspectforge-alternative', (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'inspectforge-alternative.html'))
);
app.get('/estimate', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'estimate.html')));
// Blog: static HTML under public/blog/, one file per post. The slug
// pattern is deliberately generic so new posts are just new files —
// no route change needed when a post is published.
app.get('/blog', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'blog', 'index.html')));
app.get('/blog/:slug', (req, res, next) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(req.params.slug)) return next();
  const file = path.join(PUBLIC_DIR, 'blog', `${req.params.slug}.html`);
  return res.sendFile(file, (err) => {
    if (err) next();
  });
});
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    setHeaders: (res, filePath) => {
      // App code and styles must never be served stale after a redeploy:
      // force revalidation on every load (ETags keep this cheap), so the
      // next page refresh always picks up the newest app.js/pdf.js/CSS.
      if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// JSON error handler (multer upload errors land here too).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return;
  const status = err.name === 'MulterError' ? 400 : 500;
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

const PORT = Number(process.env.PORT) || 3000;

db.init()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`InspectReport AI listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[db] Failed to initialise database:', err);
    process.exit(1);
  });
