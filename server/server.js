// Process bootstrap: open the database, open the access log, serve.
// The routing and queries live in app.js, which knows nothing about either.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DB_PATH = process.env.DB_PATH || join(ROOT, 'db', 'ao3.sqlite3');
const LOG_PATH = join(ROOT, 'logs', 'access.log');
const PORT = process.env.PORT || 4173;
const HOST = process.env.HOST || '127.0.0.1';

mkdirSync(join(ROOT, 'logs'), { recursive: true });
const accessLog = createWriteStream(LOG_PATH, { flags: 'a' });
// An unlistened stream error (full disk, bad permissions) would take the server
// down; losing the log file is not worth stopping serving over.
accessLog.on('error', (err) => console.error('access log:', err.message));

// Read-write: /api/import and PATCH /api/fics/:id both write.
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA busy_timeout = 5000');

const app = createApp(db);

const server = createServer((req, res) => {
  // One access log line per request, written once the response is on the wire
  // so the status and duration are the real ones.
  const start = performance.now();
  res.on('finish', () => {
    const ms = Math.round(performance.now() - start);
    const line = `${req.method} ${req.url} ${res.statusCode} ${ms}ms`;
    console.log(line);
    // The file keeps a timestamp the live terminal does not need.
    accessLog.write(`${new Date().toISOString()} ${line}\n`);
  });

  return app(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`AO3 archive browser running at http://${HOST}:${PORT}`);
});
