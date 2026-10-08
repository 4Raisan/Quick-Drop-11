const BUCKET = 'quickdrop-files';
function createSupabaseStore(client) {
  const bucket = client.storage.from(BUCKET);
  const check = result => { if (result.error) throw result.error; return result.data; };
  const pathFor = id => 'attachments-v1/PUBLIC/' + id;
  return {
    mode: 'community', provider: 'supabase',
    async list() {
      const records = []; let start = 0;
      for (;;) {
        const page = check(await client.from('quickdrop_shares').select('data').order('id').range(start, start + 999));
        records.push(...page.map(row => row.data));
        if (page.length < 1000) break;
        start += 1000;
      }
      return records;
    },
    async add(item) {
      const result = await client.from('quickdrop_shares').insert({ id: item.id, request_id: item.requestId, data: item });
      if (result.error?.code === '23505') {
        const rows = check(await client.from('quickdrop_shares').select('data').eq('request_id', item.requestId));
        if (rows[0] && rows[0].data.text === item.text && (rows[0].data.file?.sha256 || '') === (item.file?.sha256 || '')) return rows[0].data;
        throw Object.assign(new Error('Share ID is taken'), { code: 'ID_TAKEN' });
      }
      check(result); return item;
    },
    async finishFile(item) { check(await client.from('quickdrop_shares').update({ data: item }).eq('id', item.id).eq('request_id', item.requestId)); },
    async putFile(id, bytes, type) {
      const result = await bucket.upload(pathFor(id), bytes, { contentType: type, upsert: false });
      if (result.error) {
        const previous = check(await bucket.download(pathFor(id)));
        if (!Buffer.from(await previous.arrayBuffer()).equals(bytes)) throw result.error;
      }
      return '/api/files?id=' + encodeURIComponent(id);
    },
    async signUpload(item) { return check(await bucket.createSignedUploadUrl(pathFor(item.file.storageId), { upsert: false })); },
    async downloadUrl(item) {
      const remaining = Math.floor((item.expiresAt - Date.now()) / 1000);
      if (remaining < 1) throw new Error('File expired');
      return check(await bucket.createSignedUrl(pathFor(item.file.storageId), Math.min(60, remaining))).signedUrl;
    },
    async head(pathname) {
      const data = check(await bucket.info(pathname));
      const url = check(await bucket.createSignedUrl(pathname, 60)).signedUrl;
      return { pathname, size: Number(data.size ?? data.metadata?.size), url };
    },
    async remove(id, record) {
      if (record?.file) check(await bucket.remove([pathFor(record.file.storageId || id)]));
      let query = client.from('quickdrop_shares').delete().eq('id', id);
      if (record?.requestId) query = query.eq('request_id', record.requestId);
      check(await query);
    },
    async stats() { return check(await client.rpc('quickdrop_storage_stats')); },
    async cleanupOrphans() {
      const live = new Set((await this.list()).filter(item => item.file).map(item => item.file.storageId));
      let offset = 0; const old = [];
      for (;;) {
        const page = check(await bucket.list('attachments-v1/PUBLIC', { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }));
        for (const file of page) if (!live.has(file.name) && Date.now() - new Date(file.created_at).getTime() >= 11 * 3600000) old.push(pathFor(file.name));
        if (page.length < 1000) break;
        offset += 1000;
      }
      for (let i = 0; i < old.length; i += 100) check(await bucket.remove(old.slice(i, i + 100)));
    }
  };
}
let cachedClient;
function defaultSupabaseStore() {
  const projectUrl = process.env.QUICK_DROP_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.QUICK_DROP_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceKey) throw new Error('Supabase is not configured');
  cachedClient ||= require('@supabase/supabase-js').createClient(projectUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return createSupabaseStore(cachedClient);
}
module.exports = { createSupabaseStore, defaultSupabaseStore };
