const { defaultStore, activeRecords } = require('../lib/storage');
const { readJson, sameOrigin, send } = require('../lib/http');
const { reserve, complete, pathnameFor } = require('../lib/direct-uploads');
const { MAX_FILE_SIZE } = require('../lib/files');
const { publicStorageError } = require('../lib/storage-error');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-origin uploads are not allowed' });
  try {
    const store = defaultStore();
    if (store.mode === 'local') return send(res, 400, { error: 'Use local uploads' });
    const body = await readJson(req);
    const blob = require('@vercel/blob');
    if (body.action === 'prepare') {
      const item = await reserve(store, body);
      return send(res, 200, { item, pathname: pathnameFor(item) });
    }
    if (body.action === 'complete') {
      const item = (await activeRecords(store)).find(record => record.requestId === body.requestId && record.file);
      if (!item) return send(res, 404, { error: 'Upload reservation expired' });
      return send(res, 200, { success: true, item: await complete(store, blob, item) });
    }
    const { handleUpload } = require('@vercel/blob/client');
    const result = await handleUpload({ request: req, body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const data = JSON.parse(clientPayload || '{}');
        const item = (await activeRecords(store)).find(record => record.requestId === data.requestId && record.file?.pending);
        if (!item || pathname !== pathnameFor(item)) throw new Error('Invalid upload reservation');
        return { allowedContentTypes: [item.file.type], maximumSizeInBytes: Math.min(MAX_FILE_SIZE, item.file.size), validUntil: Math.min(Date.now() + 10 * 60000, item.expiresAt), addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60 };
      }
    });
    return send(res, 200, result);
  } catch (err) { console.error('Upload service failure:', err.name, err.message); return send(res, err.status || 503, err.status ? { error: err.message } : publicStorageError(err)); }
};
