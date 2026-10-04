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
function sameItem(a, b) {
  return a.requestId === b.requestId && a.text === b.text && (a.file?.sha256 || '') === (b.file?.sha256 || '');
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
    async add(item) {
      await fs.mkdir(directory, { recursive: true });
      const target = path.join(directory, item.id + '.json');
      const temporary = path.join(directory, '.' + crypto.randomUUID() + '.tmp');
      try {
        await fs.writeFile(temporary, JSON.stringify(item), { flag: 'wx' });
        try { await fs.link(temporary, target); return item; }
        catch (err) {
          if (err.code !== 'EEXIST') throw err;
          const existing = JSON.parse(await fs.readFile(target, 'utf8'));
          if (!sameItem(existing, item)) throw Object.assign(new Error('Share ID is taken'), { code: 'ID_TAKEN' });
          return existing;
        }
      } finally { await fs.rm(temporary, { force: true }); }
    },
    async finishFile(item) {
      const updated = { ...item, completedAt: Date.now() };
      const target = path.join(directory, item.id + '_' + crypto.randomUUID() + '.complete.json');
      const temporary = path.join(directory, '.' + crypto.randomUUID() + '.tmp');
      try {
        await fs.writeFile(temporary, JSON.stringify(updated), { flag: 'wx' });
        await fs.link(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
    },
    async putFile(id, buffer) {
      await fs.mkdir(path.join(directory, 'files'), { recursive: true });
      const temporary = filePath('.' + crypto.randomUUID() + '.tmp');
      try {
        await fs.writeFile(temporary, buffer, { flag: 'wx' });
        try { await fs.link(temporary, filePath(id)); }
        catch (err) {
          if (err.code !== 'EEXIST') throw err;
          if (!(await fs.readFile(filePath(id))).equals(buffer)) throw new Error('File request ID conflict');
        }
      } finally { await fs.rm(temporary, { force: true }); }
      return '/api/files?id=' + encodeURIComponent(id);
    },
    async readFile(id) { return fs.readFile(filePath(id)); },
    async remove(id, record) {
      if (!record) {
        try { record = JSON.parse(await fs.readFile(path.join(directory, id + '.json'), 'utf8')); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
      // Keep metadata until attachment deletion succeeds so cleanup can retry.
      await fs.rm(filePath(record?.file?.storageId || id), { force: true });
      const names = await fs.readdir(directory);
      await Promise.all(names.filter(name => name === id + '.json' || (name.startsWith(id + '_') && name.endsWith('.complete.json'))).map(name => fs.rm(path.join(directory, name), { force: true })));
    }
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
    async add(item) {
      try {
        await blob.put(prefix + item.id + '.json', JSON.stringify(item), {
          access: 'public', addRandomSuffix: false, allowOverwrite: false,
          contentType: 'application/json', cacheControlMaxAge: 60
        });
        return item;
      } catch (err) {
        let existing;
        try {
          const existingBlob = await blob.head(prefix + item.id + '.json');
          const response = await fetcher(existingBlob.url, { signal: AbortSignal.timeout(10000) });
          if (!response.ok) throw err;
          existing = await response.json();
        } catch { throw err; }
        if (existing.id === item.id && sameItem(existing, item)) return existing;
        throw Object.assign(new Error('Share ID is taken'), { code: 'ID_TAKEN' });
      }
    },
    async finishFile(item) {
      await blob.put(prefix + item.id + '_' + item.requestId + '.complete.json', JSON.stringify({ ...item, completedAt: Date.now() }), {
        access: 'public', addRandomSuffix: false, allowOverwrite: true,
        contentType: 'application/json', cacheControlMaxAge: 60
      });
    },
    async putFile(id, buffer, type) {
      try {
        const result = await blob.put(fileName(id), buffer, { access: 'public', addRandomSuffix: false,
          allowOverwrite: false, contentType: type, cacheControlMaxAge: 60 });
        return result.url;
      } catch (err) {
        try {
          const existing = await blob.head(fileName(id));
          const response = await fetcher(existing.url, { signal: AbortSignal.timeout(10000) });
          if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(buffer)) throw err;
          return existing.url;
        } catch { throw err; }
      }
    },
    async remove(id, record) {
      await blob.del(fileName(record?.file?.storageId || id));
      if (record?.requestId && record.file) await blob.del(prefix + id + '_' + record.requestId + '.complete.json');
      await blob.del(prefix + id + '.json');
    }
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

async function activeRecords(store, now = Date.now()) {
  const records = (await store.list()).map(item => ({ ...item, expiresAt: Math.min(item.expiresAt, item.createdAt + TTL) }));
  for (const item of records) {
    if (!item || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || typeof item.text !== 'string' || !Number.isFinite(item.expiresAt)) {
      throw new Error('Invalid stored record');
    }
  }
  await Promise.all(records.filter(item => item.expiresAt <= now).map(item => store.remove(item.id, item)));
  return records.filter(item => item.expiresAt > now).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

async function cleanupAllRooms() {
  if (usesBlob()) {
    // Enumerate metadata once globally instead of charging a list operation per room.
    const blob = require('@vercel/blob');
    const metadata = [...await listBlobs(blob, ROOMS_PREFIX), ...await listBlobs(blob, PREFIX)];
    const liveAttachments = new Set();
    for (let offset = 0; offset < metadata.length; offset += 10) {
      await Promise.all(metadata.slice(offset, offset + 10).map(async entry => {
        const response = await fetch(entry.url, { signal: AbortSignal.timeout(10000) });
        if (response.status === 404) return;
        if (!response.ok) throw new Error('Cleanup storage read failed');
        const item = await response.json();
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || !Number.isFinite(item.expiresAt)) throw new Error('Invalid cleanup record');
        const room = entry.pathname.startsWith(PREFIX) ? 'PUBLIC' : normalizeRoom(entry.pathname.split('/')[1]);
        if (Math.min(item.expiresAt, item.createdAt + TTL) <= Date.now()) await defaultStore(room).remove(item.id, item);
        else if (item.file) liveAttachments.add('attachments-v1/' + room + '/' + (item.file.storageId || item.id));
      }));
    }
    // Leave recent orphan uploads alone: their metadata write may still be in flight.
    const attachments = await listBlobs(blob, 'attachments-v1/');
    for (const file of attachments) {
      if (!liveAttachments.has(file.pathname) && Date.now() - new Date(file.uploadedAt).getTime() >= TTL) await blob.del(file.url);
    }
    return;
  }
  const rooms = new Set(['PUBLIC']);
  const baseDirectory = path.join(__dirname, '..', '.data');
  try { for (const name of await fs.readdir(path.join(baseDirectory, 'rooms'))) rooms.add(normalizeRoom(name)); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  for (const room of rooms) {
    const records = await activeRecords(defaultStore(room));
    const live = new Set(records.filter(item => item.file).map(item => item.file.storageId || item.id));
    const directory = path.join(room === 'PUBLIC' ? baseDirectory : path.join(baseDirectory, 'rooms', room), 'files');
    try {
      for (const name of await fs.readdir(directory)) {
        const target = path.join(directory, name);
        const stats = await fs.stat(target);
        if (!live.has(name) && Date.now() - stats.mtimeMs >= TTL) await fs.rm(target, { force: true });
      }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

module.exports = { createFileStore, createBlobStore, defaultStore, activeRecords, cleanupAllRooms, normalizeRoom, TTL, PREFIX };
