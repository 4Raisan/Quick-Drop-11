// One-time migration. Never runs as part of npm start or deployment.
const { createBlobStore, TTL } = require('../lib/storage');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { createHandler } = require('../api/texts');
const path = require('node:path');
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
for (const line of envContent.split(/\r?\n/)) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '');
}
const blob = require('@vercel/blob');
async function all(prefix) {
  const files = []; let cursor;
  do { const page = await blob.list({ prefix, cursor }); files.push(...page.blobs); cursor = page.hasMore ? page.cursor : undefined; } while (cursor);
  return files;
}
(async () => {
  const versions = await all('feed/data_');
  const legacy = await all('community_texts.json');
  const candidates = versions.length ? versions : legacy;
  candidates.sort((a,b) => new Date(b.uploadedAt) - new Date(a.uploadedAt) || b.pathname.localeCompare(a.pathname));
  if (!candidates.length) { console.log('No legacy snapshots found.'); return; }
  const response = await fetch(candidates[0].url, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  if (!response.ok) throw new Error('Cannot read legacy snapshot');
  const records = await response.json();
  if (!Array.isArray(records)) throw new Error('Invalid legacy snapshot');
  const active = records.map(item => ({ ...item, expiresAt: item.expiresAt || item.createdAt + TTL })).filter(item => Math.min(item.expiresAt, item.createdAt + TTL) > Date.now());
  if (!active.every(item => /^[a-zA-Z0-9_-]{1,100}$/.test(item.id) && typeof item.text === 'string')) throw new Error('Invalid legacy records');
  console.log(`${active.length} active snippets available for migration; ${versions.length + legacy.length} legacy snapshots retained.`);
  if (!process.argv.includes('--apply')) { console.log('Dry run. Stop old writers before running npm run migrate -- --apply.'); return; }
  const store = createBlobStore(blob);
  const handler = createHandler(() => store);
  for (const item of active) {
    const req = Readable.from([Buffer.from(JSON.stringify({ text: item.text, requestId: 'migration_' + item.id }))]);
    Object.assign(req, { method: 'POST', url: '/api/texts', headers: {} });
    let result;
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(body) { result = { status: this.status, body: JSON.parse(body) }; } };
    await handler(req, res);
    if (![200,201].includes(result.status)) throw new Error(result.body.error);
    const saved = result.body.item;
    saved.createdAt = item.createdAt; saved.expiresAt = Math.min(item.expiresAt, item.createdAt + TTL);
    await store.finishFile(saved);
  }
  console.log('Migration complete. Legacy files were preserved; remove them separately after verification.');
})().catch(err => { console.error(err.message); process.exitCode = 1; });
