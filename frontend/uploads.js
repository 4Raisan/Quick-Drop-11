import { upload } from '@vercel/blob/client';
async function post(data) {
  const response = await fetch('/api/uploads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || 'Upload unavailable'), { code: body.code });
  return body;
}
window.transferUploads = {
  async share(task) {
    const bytes = Uint8Array.from(atob(task.file.base64), character => character.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const prepared = await post({ action: 'prepare', text: task.content, requestId: task.requestId, file: { name: task.file.name, type: task.file.type, size: bytes.length, sha256 } });
    if (!prepared.item.file.pending) return new Response(JSON.stringify({ success: true, item: prepared.item }), { status: 200 });
    // If an earlier attempt uploaded successfully but lost its response, finish
    // that object before trying an immutable upload again.
    try {
      const completed = await post({ action: 'complete', requestId: task.requestId });
      return new Response(JSON.stringify(completed), { status: 200 });
    } catch { /* No uploaded object yet. */ }
    if (prepared.provider === 'supabase') {
      const response = await fetch(prepared.signedUploadUrl, { method: 'PUT', headers: { 'Content-Type': task.file.type, 'x-upsert': 'false' }, body: bytes, signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error('File transfer failed; your upload remains queued');
    } else {
      await upload(prepared.pathname, new Blob([bytes], { type: task.file.type }), { access: 'public', contentType: task.file.type, handleUploadUrl: '/api/uploads', clientPayload: JSON.stringify({ requestId: task.requestId }), multipart: false });
    }
    const completed = await post({ action: 'complete', requestId: task.requestId });
    return new Response(JSON.stringify(completed), { status: 200 });
  }
};
