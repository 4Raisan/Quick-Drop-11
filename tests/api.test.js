const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createHandler } = require('../api/texts');
const { createFileStore, createBlobStore, activeRecords } = require('../lib/storage');

async function request(handler, method, body, url = '/api/texts', headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(req, { method, url, headers });
  let result;
  const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { result = { status: this.status, body: body ? JSON.parse(body) : null }; } };
  await handler(req, res);
  return result;
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quick-drop-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createFileStore(directory);
  return { store, handler: createHandler(() => store), directory };
}

test('parallel additions survive, retries are idempotent, and files survive a new store instance', async t => {
  const { store, handler, directory } = await fixture(t);
  const replies = await Promise.all(Array.from({ length: 25 }, (_, i) => request(handler, 'POST', { text: `text ${i}`, requestId: `request_identifier_${i}` })));
  assert.ok(replies.every(r => r.status === 201));
  assert.equal((await request(handler, 'GET')).body.texts.length, 25);
  const retries = await Promise.all(Array.from({ length: 10 }, () => request(handler, 'POST', { text: 'retry', requestId: 'stable_request_identifier' })));
  assert.ok(retries.every(r => [200, 201].includes(r.status)));
  assert.equal((await store.list()).length, 26);
  assert.equal((await createFileStore(directory).list()).length, 26);
  assert.equal((await request(handler, 'POST', { text: 'changed', requestId: 'stable_request_identifier' })).status, 409);
});

test('delete alongside posts does not restore deleted data or lose unrelated posts', async t => {
  const { store, handler } = await fixture(t);
  const first = await request(handler, 'POST', { text: 'delete me' });
  await Promise.all([request(handler, 'DELETE', undefined, '/api/texts?id=' + first.body.item.id), ...Array.from({ length: 10 }, (_, i) => request(handler, 'POST', { text: `keep ${i}` }))]);
  const list = await store.list();
  assert.equal(list.length, 10);
  assert.ok(list.every(item => item.text.startsWith('keep ')));
});

test('expired records are physically removed without removing active records', async t => {
  const { store } = await fixture(t);
  await store.add({ id: 'expired', text: 'old', createdAt: 1, expiresAt: 2 });
  await store.add({ id: 'active', text: 'new', createdAt: 3, expiresAt: 999 });
  assert.deepEqual((await activeRecords(store, 100)).map(x => x.id), ['active']);
  assert.deepEqual((await store.list()).map(x => x.id), ['active']);
});

test('read, write and deletion failures return 503', async () => {
  const broken = async () => { throw new Error('injected failure'); };
  for (const [method, store, body, url] of [
    ['GET', { list: broken }],
    ['POST', { list: async () => [], add: broken }, { text: 'save' }],
    ['DELETE', { list: async () => [{id:'valid'}], remove: broken }, undefined, '/api/texts?id=valid']
  ]) assert.equal((await request(createHandler(() => store), method, body, url)).status, 503);
});

test('body validation, cross-origin writes and unsafe IDs are rejected', async t => {
  const { handler } = await fixture(t);
  for (const body of [{ text: '' }, { text: 3 }, { text: 'x'.repeat(10001) }, 'invalid JSON', { text: 'x', requestId: '../unsafe' }]) {
    assert.equal((await request(handler, 'POST', body)).status, 400);
  }
  assert.equal((await request(handler, 'POST', { text: 'x'.repeat(70000) })).status, 413);
  assert.equal((await request(handler, 'DELETE', undefined, '/api/texts?id=../bad')).status, 400);
  assert.equal((await request(handler, 'POST', { text: 'x' }, '/api/texts', { origin: 'https://other.example', host: 'localhost' })).status, 403);
});

test('Blob records paginate and mutations never rewrite the board', async () => {
  const values = new Map(); const puts = [];
  const blob = {
    list: async ({ cursor }) => cursor ? { blobs: [{ url: 'second' }], hasMore: false } : { blobs: [{ url: 'first' }], hasMore: true, cursor: 'next' },
    put: async (name, data, options) => { puts.push(options); values.set(name, JSON.parse(data)); },
    del: async name => values.delete(name)
  };
  const store = createBlobStore(blob, async url => ({ ok: true, json: async () => ({ id: url, text: url, expiresAt: 999 }) }));
  assert.equal((await store.list()).length, 2);
  await Promise.all(['a','b'].map(id => store.add({ id, text: id })));
  assert.equal(values.size, 2);
  assert.ok(puts.every(options => options.allowOverwrite === false));
  await store.remove('a'); assert.equal(values.size, 1);
});
