const crypto = require('node:crypto');
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const TYPES = {
  'image/png': { extension: '.png', matches: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) },
  'image/jpeg': { extension: '.jpg', matches: b => b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255 },
  'image/webp': { extension: '.webp', matches: b => b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP' },
  'application/pdf': { extension: '.pdf', matches: b => b.toString('ascii',0,5) === '%PDF-' }
};
function validateFile(file) {
  const reject = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
  if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 180 || /[\x00-\x1f/\\]/.test(file.name)) reject('Invalid filename');
  const type = TYPES[file.type];
  if (!type) reject('Only PNG, JPEG, WebP images and PDF files are supported');
  if (typeof file.base64 !== 'string' || !file.base64.length || file.base64.length > Math.ceil(MAX_FILE_SIZE / 3) * 4) reject('File must be 5 MB or smaller', 413);
  if (file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) reject('Invalid file encoding');
  const buffer = Buffer.from(file.base64, 'base64');
  if (buffer.toString('base64') !== file.base64) reject('Invalid file encoding');
  if (!buffer.length || buffer.length > MAX_FILE_SIZE) reject('File must be 5 MB or smaller', 413);
  if (!type.matches(buffer)) reject('File content does not match its type');
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!(file.type === 'image/jpeg' ? ['.jpg','.jpeg'] : [type.extension]).includes(extension)) reject('Filename extension does not match its type');
  return { buffer, metadata: { name: file.name.trim(), type: file.type, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') } };
}
module.exports = { validateFile, MAX_FILE_SIZE };
