const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseStore } = require('../lib/supabase-storage');
test('Supabase adapter keeps downloads private and bounds their signed lifetime', async () => {
  const calls = [];
  const store = createSupabaseStore({ storage: { from: name => {
    assert.equal(name, 'quickdrop-files');
    return {
      info: async () => ({ data: { size: 5242880 }, error: null }),
      createSignedUrl: async (path, seconds) => { calls.push({ path, seconds }); return { data: { signedUrl: 'https://storage.example/signed' }, error: null }; },
      createSignedUploadUrl: async (path, options) => { assert.equal(options.upsert, false); return { data: { signedUrl: 'https://storage.example/upload' }, error: null }; }
    };
  } } });
  const item = { file: { storageId: '1234_request' }, expiresAt: Date.now() + 11000 };
  assert.equal(await store.downloadUrl(item), 'https://storage.example/signed');
  assert.ok(calls[0].seconds <= 11 && calls[0].seconds > 0);
  assert.equal((await store.head('attachments-v1/PUBLIC/1234_request')).size, 5242880);
  assert.equal((await store.signUpload(item)).signedUrl, 'https://storage.example/upload');
  await assert.rejects(store.downloadUrl({ ...item, expiresAt: Date.now() - 1 }), /expired/);
});
