const { cleanupAllRooms } = require('../lib/storage');
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.CRON_SECRET || req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) {
    res.writeHead(401); res.end('Unauthorized'); return;
  }
  if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }
  try { await cleanupAllRooms(); res.writeHead(200); res.end('Cleanup complete'); }
  catch (err) { console.error('Cleanup failed:', err.message); res.writeHead(503); res.end('Cleanup failed'); }
};
