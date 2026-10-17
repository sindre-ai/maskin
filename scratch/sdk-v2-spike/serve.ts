import http from 'node:http';
import { buildFetch } from './server.ts';
const f = buildFetch();
const port = Number(process.argv[2] || 8765);
http.createServer(async (req, res) => {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const body = Buffer.concat(chunks).toString('utf8');
	const headers: Record<string, string> = {};
	for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
	let method = '';
	try { const j = JSON.parse(body); method = Array.isArray(j) ? 'BATCH' : j.method; } catch {}
	const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : body });
	const response = await f(request);
	const text = await response.text();
	const rh: Record<string, string> = {};
	response.headers.forEach((v, k) => (rh[k] = v));
	console.log(JSON.stringify({ http: req.method, rpc: method, ua: headers['user-agent'], pv: headers['mcp-protocol-version'], status: response.status, ct: rh['content-type'], req: body.slice(0, 200), res: text.slice(0, 160) }));
	res.writeHead(response.status, rh);
	res.end(text);
}).listen(port, '127.0.0.1', () => console.log('listening', port));
