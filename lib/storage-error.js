function publicStorageError(error) {
  if (/store has been suspended/i.test(error?.message || '')) {
    return { error: 'Site storage is suspended by the provider. Your upload remains saved on this device. Try Refresh after storage is restored.', code: 'STORAGE_SUSPENDED' };
  }
  return { error: 'Storage temporarily unavailable. Your upload remains on this device; please retry.' };
}
module.exports = { publicStorageError };
