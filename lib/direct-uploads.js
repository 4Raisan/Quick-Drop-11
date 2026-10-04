const crypto = require('node:crypto');
const { activeRecords, TTL } = require('./storage');
const { validateFile, MAX_FILE_SIZE } = require('./files');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function metadata(data) {
  if (!data || typeof data.text !== 'string' || data.text.trim().length > 10000 || !/^[a-zA-Z0-9_-]{16,80}$/.test(data.requestId)) fail('Invalid share');
  const file = data.file;
  if (!file || !Number.isInteger(file.size) || file.size < 1 || file.size > MAX_FILE_SIZE || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('Invalid file details');
  // Reuse filename, extension and signature validation with a minimal sample.
  const samples = { 'image/png': Buffer.from([137,80,78,71,13,10,26,10]), 'image/jpeg': Buffer.from([255,216,255]), 'image/webp': Buffer.from('RIFF0000WEBP'), 'application/pdf': Buffer.from('%PDF-') };
  validateFile({ name: file.name, type: file.type, base64: (samples[file.type] || Buffer.alloc(0)).toString('base64') });
  return { name: file.name.trim(), type: file.type, size: file.size, sha256: file.sha256 };
}
async function reserve(store, data) {
  const file = metadata(data), text = data.text.trim();
  const records = await activeRecords(store);
  const existing = records.find(item => item.requestId === data.requestId);
  if (existing) {
    if (existing.text !== text || existing.file?.sha256 !== file.sha256 || existing.file?.size !== file.size || existing.file?.type !== file.type || existing.file?.name !== file.name) fail('Request ID already used', 409);
    return existing;
  }
  const first = crypto.createHash('sha256').update(data.requestId).digest().readUInt32BE(0) % 10000;
  const used = new Set(records.map(item => item.id));
  for (let offset = 0; offset < 10000; offset++) {
    const id = String((first + offset) % 10000).padStart(4, '0');
    if (used.has(id)) continue;
    const now = Date.now();
    const item = { id, requestId: data.requestId, text, createdAt: now, expiresAt: now + TTL, file: { ...file, pending: true, storageId: id + '_' + data.requestId } };
    try { return await store.add(item); } catch (err) { if (err.code !== 'ID_TAKEN') throw err; }
  }
  fail('All share IDs are in use', 503);
}
const pathnameFor = item => 'attachments-v1/PUBLIC/' + item.file.storageId;

module.exports = { reserve, pathnameFor };
