const { defaultStore, activeRecords, normalizeRoom } = require('../lib/storage');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id');
  if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) { res.writeHead(400); res.end('Invalid file ID'); return; }
  try {
    const store = defaultStore();
    const item = (await activeRecords(store)).find(item => item.id === id || item.file?.storageId === id);
    if (!item?.file || item.file.pending) { res.writeHead(404); res.end('File expired or not found'); return; }
    if (store.mode !== 'local') { res.writeHead(302, { Location: item.file.url }); res.end(); return; }
    const buffer = await store.readFile(item.file.storageId || item.id);
    res.writeHead(200, { 'Content-Type': item.file.type, 'Content-Length': buffer.length,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(item.file.name) });
    res.end(buffer);
  } catch (err) { console.error('Download failed:', err.message); res.writeHead(503); res.end('File unavailable'); }
};
