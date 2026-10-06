const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { reserve, complete, pathnameFor } = require('../lib/direct-uploads');
function memoryStore() {
  const records = [];
  return { list: async () => records, add: async item => { if (records.some(record => record.id === item.id)) throw Object.assign(new Error('Taken'), { code: 'ID_TAKEN' }); records.push(item); return item; }, finishFile: async () => {}, remove: async id => { records.splice(records.findIndex(record => record.id === id), 1); } };
}
test('direct uploads reserve an idempotent slot and verify full 5 MiB bytes', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024); bytes.write('%PDF-');
  const data = { text: 'caption', requestId: crypto.randomUUID(), file: { name: 'example.pdf', type: 'application/pdf', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
  const store = memoryStore(), item = await reserve(store, data);
  assert.match(item.id, /^\d{4}$/); assert.equal(item.file.pending, true);
  assert.equal((await reserve(store, data)).id, item.id);
  await assert.rejects(reserve(store, { ...data, text: 'changed' }), /already used/);
  const result = await complete(store, { head: async name => ({ pathname: name, size: bytes.length, url: 'https://trusted.example/file' }) }, item, async () => new Response(bytes));
  assert.equal(result.file.pending, undefined); assert.equal(result.file.size, bytes.length);
});
test('direct uploads reject oversized reservations and mismatched storage objects', async () => {
  const store = memoryStore();
  const data = { text: '', requestId: crypto.randomUUID(), file: { name: 'file.pdf', type: 'application/pdf', size: 6, sha256: 'a'.repeat(64) } };
  await assert.rejects(reserve(store, { ...data, file: { ...data.file, size: 5 * 1024 * 1024 + 1 } }), /Invalid file/);
  const item = await reserve(store, data);
  await assert.rejects(complete(store, { head: async () => ({ pathname: 'wrong', size: 6 }) }, item), /does not match/);
  await assert.rejects(complete(store, { head: async () => ({ pathname: pathnameFor(item), size: 6, url: 'https://trusted.example/file' }) }, item, async () => new Response('%PDF-x')), /verification failed/);
  assert.equal((await store.list()).length, 0);
});
