// Temp-Transfer - Local Development Server
// In production on Vercel, static files are served by the Edge CDN
// and api/texts.js is the serverless function. This file is only for local dev.
const http = require('http');
const fs = require('fs');
const path = require('path');
const apiFilesHandler = require('./api/files.js');
const apiTextsHandler = require('./api/texts.js');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

// Cache durations (seconds)
const CACHE_DURATIONS = {
  '.html': 0,
  '.css': 0,
  '.js': 0,
  '.svg': 86400,
  '.png': 86400,
  '.ico': 86400
};

function handler(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const reqPath = urlObj.pathname.replace(/\/+/g, '/');

  // Check if API route
  if (reqPath === '/api/texts') {
    return apiTextsHandler(req, res);
  }


  if (reqPath === '/api/files') return apiFilesHandler(req, res);

  // Otherwise serve static files from public/
  let filePathName = reqPath;
  if (filePathName === '/' || filePathName === '') {
    filePathName = '/index.html';
  }

  let decoded;
  try { decoded = decodeURIComponent(filePathName); } catch { res.writeHead(400); res.end('Bad Request'); return; }
  const filePath = path.resolve(PUBLIC_DIR, '.' + decoded);
  const relative = path.relative(PUBLIC_DIR, filePath);

  // Security: prevent directory traversal
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Return 404 for missing files — no SPA fallback
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheDuration = CACHE_DURATIONS[ext] || 0;

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server Error');
      } else {
        const headers = { 'Content-Type': contentType };
        if (cacheDuration > 0) {
          headers['Cache-Control'] = `public, max-age=${cacheDuration}`;
        } else {
          headers['Cache-Control'] = 'no-cache';
        }
        res.writeHead(200, headers);
        res.end(content);
      }
    });
  });
}

module.exports = handler;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  const server = http.createServer(handler);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Try a different port with PORT=XXXX npm start`);
    } else {
      console.error('Server error:', err.message);
    }
    process.exit(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Temp-Transfer running at http://localhost:${PORT}`);
  });
}
