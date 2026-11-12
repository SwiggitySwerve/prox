// Serves a built index.html at / and proxies everything else to the live prox nginx.
const dir = process.argv[2];
const port = Number(process.argv[3] ?? 15180);
const html = Bun.gzipSync(await Bun.file(`${dir}/index.html`).arrayBuffer());
Bun.serve({
  port, hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html')
      return new Response(html, { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'cache-control': 'no-store' } });
    const target = `http://127.0.0.1:18318${url.pathname}${url.search}`;
    const headers = new Headers(req.headers); headers.delete('host');
    const res = await fetch(target, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(), redirect: 'manual', decompress: true } as RequestInit);
    const out = new Headers(res.headers); out.delete('content-encoding'); out.delete('content-length');
    return new Response(res.body, { status: res.status, headers: out });
  },
});
console.log('serving', dir, port);
