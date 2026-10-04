const crypto = require('node:crypto');
const { defaultStore, activeRecords, normalizeRoom, TTL } = require('../lib/storage');
const { validateFile } = require('../lib/files');
const MAX_BODY = 7 * 1024 * 1024;

async function parseBody(req) {
  if (req.body !== undefined) {
    const encoded = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(encoded) > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function createHandler(storeFactory = defaultStore) {
  return async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The intentionally public board is same-origin; deletion remains communal.
    if (req.headers?.origin && req.headers.origin !== `${req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http')}://${req.headers.host}`) {
      return send(403, { error: 'Cross-origin writes are not allowed' });
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
      return send(405, { error: 'Method not allowed' });
    }
    try {
      const store = storeFactory();
      if (req.method === 'GET') {
        const texts = await activeRecords(store);
        const params = new URL(req.url, 'http://localhost').searchParams;
        const query = (params.get('q') || '').trim().toLowerCase();
        if (query.length > 200) return send(400, { error: 'Search is too long' });
        const matching = texts.filter(item => !item.file?.pending && (item.id + ' ' + item.text + ' ' + (item.file?.name || '')).toLowerCase().includes(query));
        const results = matching.slice(0, 200);
        const selected = texts.find(item => !item.file?.pending && item.id === params.get('id'));
        if (selected && !results.some(item => item.id === selected.id)) results.unshift(selected);
        return send(200, { texts: results, total: texts.length, matches: matching.length, serverTime: Date.now(), mode: store.mode });
      }
      if (req.method === 'POST') {
        let data;
        try { data = await parseBody(req); }
        catch (err) { return send(err.status || 400, { error: err.status ? err.message : 'Invalid JSON body' }); }
        if (!data?.file && Buffer.byteLength(JSON.stringify(data)) > 64 * 1024) return send(413, { error: 'Text request body too large' });
        if (typeof data?.text !== 'string' || (!data.text.trim() && !data.file)) return send(400, { error: 'Text content is required' });
        const text = data.text.trim();
        if (text.length > 10000) return send(400, { error: 'Text too long (max 10,000 characters)' });
        if (data.requestId !== undefined && !/^[a-zA-Z0-9_-]{16,80}$/.test(data.requestId)) return send(400, { error: 'Invalid request ID' });
        let attachment;
        if (data.file) {
          try { attachment = validateFile(data.file); } catch (err) { return send(err.status || 400, { error: err.message }); }
        }
        const requestId = data.requestId || crypto.randomUUID();
        const texts = await activeRecords(store);
        const existing = texts.find(item => item.requestId === requestId);
        if (existing) {
          if (existing.text !== text || (existing.file?.sha256 || '') !== (attachment?.metadata.sha256 || '')) return send(409, { error: 'Request ID already used' });
          if (attachment && existing.file?.pending) {
            const url = await store.putFile(existing.file.storageId || existing.id, attachment.buffer, attachment.metadata.type);
            existing.file = { ...attachment.metadata, storageId: existing.file.storageId || existing.id, url };
            await store.finishFile(existing);
          }
          return send(200, { success: true, item: existing });
        }
        const now = Date.now();
        const used = new Set(texts.map(item => item.id));
        const first = crypto.createHash('sha256').update(requestId).digest().readUInt32BE(0) % 10000;
        for (let offset = 0; offset < 10000; offset++) {
          const id = String((first + offset) % 10000).padStart(4, '0');
          if (used.has(id)) continue;
          const item = { id, text, requestId, createdAt: now, expiresAt: now + TTL };
          try {
            // Claim the ID atomically before writing an attachment. A failed upload
            // retains its claim so a retry uses this same ID.
            if (attachment) item.file = { ...attachment.metadata, storageId: id + '_' + requestId, pending: true };
            const saved = await store.add(item);
            if (attachment) {
              const url = await store.putFile(saved.file.storageId, attachment.buffer, attachment.metadata.type);
              saved.file = { ...attachment.metadata, storageId: saved.file.storageId, url };
              await store.finishFile(saved);
            }
            return send(201, { success: true, item: saved });
          } catch (err) {
            if (err.code === 'ID_TAKEN') continue;
            throw err;
          }
        }
        return send(503, { error: 'All 4-digit IDs are in use. Try again after some shares expire.' });
      }
      const id = new URL(req.url, 'http://localhost').searchParams.get('id');
      if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return send(400, { error: 'Valid item ID is required' });
      const record = (await store.list()).find(item => item.id === id);
      if (record) await store.remove(id, record);
      return send(200, { success: true });
    } catch (err) {
      console.error('Clipboard storage failure:', err.message);
      return send(503, { error: 'Storage unavailable. Please retry; your text has not been confirmed saved.' });
    }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
