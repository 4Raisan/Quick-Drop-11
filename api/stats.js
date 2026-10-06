const { defaultStore } = require('../lib/storage');
const { send } = require('../lib/http');
let cached, cachedAt = 0;
module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  try {
    if (cached && Date.now() - cachedAt < 5 * 60000) return send(res, 200, cached);
    const store = defaultStore();
    const records = await store.list();
    const active = records.filter(item => Math.min(item.expiresAt, item.createdAt + 11 * 3600000) > Date.now() && !item.file?.pending);
    let storedBytes = records.reduce((sum, item) => sum + (item.file?.size || 0), 0);
    if (store.mode !== 'local') {
      storedBytes = 0; let cursor;
      do { const page = await require('@vercel/blob').list({ cursor, limit: 1000 }); storedBytes += page.blobs.reduce((sum, entry) => sum + entry.size, 0); cursor = page.hasMore ? page.cursor : undefined; if (page.hasMore && !cursor) throw new Error('Pagination failed'); } while (cursor);
    }
    cachedAt = Date.now();
    const configuredAllowance = Number(process.env.PUBLIC_STORAGE_ALLOWANCE_BYTES);
    const allowance = store.mode === 'local' ? null : (Number.isFinite(configuredAllowance) && configuredAllowance > 0 ? configuredAllowance : 1000000000);
    cached = { mode: store.mode, activeShares: active.length, storedBytes, storageAllowanceBytes: allowance, currentStorageHeadroomBytes: allowance === null ? null : Math.max(0, allowance - storedBytes), monthlyStorageUsedBytes: null, monthlyStorageRemainingBytes: null, monthlyTransferRemainingBytes: null, checkedAt: cachedAt, expiryHours: 11, maxFileBytes: 5 * 1024 * 1024 };
    return send(res, 200, cached);
  } catch { return send(res, 503, { error: 'Stats temporarily unavailable' }); }
};
