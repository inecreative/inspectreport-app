'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');
const { authMiddleware } = require('./auth');
const routes = require('./routes');

const app = express();

app.set('trust proxy', 1); // Render terminates TLS in front of the app.
app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'inspectreport-ai', aiEnabled: Boolean(process.env.AI_API_KEY) });
});

app.use('/api', routes);
app.use(express.static(path.join(__dirname, '..', 'public')));

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
