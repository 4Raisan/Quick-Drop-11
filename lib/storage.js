const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const PREFIX = 'texts-v2/';
const ROOMS_PREFIX = 'rooms-v1/';
const TTL = 11 * 60 * 60 * 1000;

function normalizeRoom(value = 'PUBLIC') {
  if (typeof value !== 'string') throw new Error('Invalid chat ID');
  const room = value.trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,32}$/.test(room)) throw new Error('Chat ID must be 6–32 letters, numbers or hyphens');
  return room;
}


function createFileStore(baseDirectory, room = 'PUBLIC') {
  room = normalizeRoom(room);
  const directory = room === 'PUBLIC' ? baseDirectory : path.join(baseDirectory, 'rooms', room);
  const filePath = id => path.join(directory, 'files', id);
  return {
    mode: 'local', room,
    async list() {
      await fs.mkdir(directory, { recursive: true });
      const names = await fs.readdir(directory);
      const records = await Promise.all(names.filter(n => /^[a-zA-Z0-9_-]+(?:\.complete)?\.json$/.test(n)).map(async name => {
        try { return JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')); }
        catch (err) { if (err.code === 'ENOENT') return null; throw err; }
      }));
      const merged = new Map();
      for (const record of records.filter(Boolean).sort((a,b) => (a.completedAt || 0) - (b.completedAt || 0))) merged.set(record.id, record);
      return [...merged.values()];
    },
    async add(item) { await fs.mkdir(directory, { recursive: true }); const target = path.join(directory, item.id + '.json'); const temporary = path.join(directory, '.' + crypto.randomUUID() + '.tmp'); try { await fs.writeFile(temporary, JSON.stringify(item), { flag: 'wx' }); await fs.link(temporary, target); return item; } finally { await fs.rm(temporary, { force: true }); } },
    
    
    
    async remove(id) { await fs.rm(path.join(directory, id + '.json'), { force: true }); }
  };
}

async function listBlobs(blob, prefix) {
  const files = []; let cursor;
  do {
    const page = await blob.list({ prefix, cursor, limit: 1000 });
    files.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
    if (page.hasMore && !cursor) throw new Error('Storage pagination failed');
  } while (cursor);
  return files;
}

function createBlobStore(blob, fetcher = fetch, room = 'PUBLIC') {
  room = normalizeRoom(room);
  const prefix = room === 'PUBLIC' ? PREFIX : ROOMS_PREFIX + room + '/items/';
  const fileName = id => 'attachments-v1/' + room + '/' + id;
  return {
    mode: 'community', room,
    async list() {
      const files = await listBlobs(blob, prefix);
      const records = [];
      for (let offset = 0; offset < files.length; offset += 10) {
        records.push(...await Promise.all(files.slice(offset, offset + 10).map(async file => {
          const response = await fetcher(file.url, { signal: AbortSignal.timeout(10000) });
          if (response.status === 404) return null;
          if (!response.ok) throw new Error('Storage read failed');
          const readEtag = response.headers?.get('etag');
          if (file.etag && readEtag && readEtag !== file.etag) throw new Error('Storage cache has not caught up; retry');
          return response.json();
        })));
      }
      const merged = new Map();
      for (const record of records.filter(Boolean).sort((a,b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt)) || a.createdAt - b.createdAt || Number(!a.file?.pending) - Number(!b.file?.pending))) merged.set(record.id, record);
      return [...merged.values()];
    },
    async add(item) { await blob.put(prefix + item.id + '.json', JSON.stringify(item), { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json', cacheControlMaxAge: 60 }); return item; },
    
    
    async remove(id) { await blob.del(prefix + id + '.json'); }
  };
}

function usesBlob() { return !!process.env.VERCEL || (process.env.QUICK_DROP_STORAGE || process.env.TEMP_TRANSFER_STORAGE) === 'blob'; }
function defaultStore(room = 'PUBLIC') {
  if (!usesBlob()) return createFileStore(path.join(__dirname, '..', '.data'), room);
  if (!process.env.BLOB_READ_WRITE_TOKEN && !(process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN)) {
    throw new Error('Blob storage is not configured');
  }
  return createBlobStore(require('@vercel/blob'), fetch, room);
}

async function activeRecords(store) { return (await store.list()).sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id)); }



module.exports = { createFileStore, createBlobStore, defaultStore, activeRecords, normalizeRoom, TTL, PREFIX };
