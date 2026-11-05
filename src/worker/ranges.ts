// The Worker's clip in byte ranges (see index.ts): its own module, as the Worker's entry may export
// nothing but its handler.

/**
 * A video served in byte ranges, as Apple's players ask for one (a whole file in answer to a range,
 * as the static files are served, and Messages' preview drops the clip altogether). One range at
 * a time; anything else is the whole file.
 */
export async function ranged(request: Request, file: Response): Promise<Response> {
  const body = new Uint8Array(await file.arrayBuffer());
  const total = body.byteLength;
  const headers = new Headers(file.headers);
  headers.set('Accept-Ranges', 'bytes');
  const head = request.method === 'HEAD';
  const m = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get('Range') ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    headers.set('Content-Length', String(total));
    return new Response(head ? null : body, { status: 200, headers });
  }
  // ("bytes=-500" is the last 500; "bytes=500-" from 500 to the end.)
  const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
  const end = m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  if (start > end || start >= total) {
    headers.set('Content-Range', `bytes */${total}`);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${total}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(head ? null : body.subarray(start, end + 1), { status: 206, headers });
}
