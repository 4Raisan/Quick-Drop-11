async function readJson(req, limit = 32768) {
  const fail = () => { throw Object.assign(new Error('Request too large'), { status: 413 }); };
  if (req.body !== undefined) {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > limit) fail();
    return JSON.parse(raw);
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > limit) fail(); chunks.push(Buffer.from(chunk)); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function sameOrigin(req) {
  return !req.headers?.origin || req.headers.origin === `${req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http')}://${req.headers.host}`;
}
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
module.exports = { readJson, sameOrigin, send };
