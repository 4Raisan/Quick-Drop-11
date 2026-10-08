(() => {
  const button = document.getElementById('statsButton');
  const dialog = document.getElementById('statsDialog');
  const content = document.getElementById('statsContent');
  const format = value => value === null ? 'Unavailable' : value < 1000000 ? (value / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' KB' : (value / 1000000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MB';
  button.addEventListener('click', async () => {
    dialog.showModal(); content.textContent = 'Loading stats…';
    try {
      const response = await fetch('/api/stats', { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json();
      const rows = [
        ['Environment', data.mode === 'local' ? 'Local preview — separate from live storage' : data.provider === 'supabase' ? 'Live Supabase storage' : 'Live Blob storage'],
        ['Active shares', String(data.activeShares)],
        ['Currently stored', format(data.storedBytes)],
        ['Space below allowance now', format(data.currentStorageHeadroomBytes)],
        [data.provider === 'supabase' ? 'Storage allowance' : 'Monthly storage allowance', data.storageAllowanceBytes === null ? 'Not applicable locally' : format(data.storageAllowanceBytes) + (data.provider === 'supabase' ? '' : '-month')],
        ['Monthly storage remaining', format(data.monthlyStorageRemainingBytes)],
        ['Monthly download remaining', format(data.monthlyTransferRemainingBytes)],
        ['File limit / expiry', '5 MB / 11 hours'],
        ['Stats checked', new Date(data.checkedAt).toLocaleString()]
      ];
      const list = document.createElement('dl');
      for (const [label, value] of rows) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; list.append(dt, dd); }
      const note = document.createElement('p');
      note.textContent = 'Current storage is a snapshot, not monthly billed usage. Exact usage and request allowances are available in the private storage-provider dashboard. Stats may be cached for 5 minutes.';
      content.replaceChildren(list, note);
    } catch { content.textContent = 'Stats are temporarily unavailable. Close and try again later.'; }
  });
  document.getElementById('closeStats').addEventListener('click', () => { dialog.close(); button.focus(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
})();
