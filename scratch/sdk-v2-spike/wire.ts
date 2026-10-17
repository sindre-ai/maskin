import http from 'node:http';
import { buildFetch } from './server.ts';

export type Rec = { req: { method: string; url: string; headers: Record<string, string>; body: string }; res: { status: number; headers: Record<string, string>; body: string } };

export async function startServer(opts: { seen?: any[]; log: Rec[]; flagModern?: boolean }) {
	const f = buildFetch(opts.seen);
	const srv = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const c of req) chunks.push(c as Buffer);
		const body = Buffer.concat(chunks).toString('utf8');
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
		const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : body });
		const response = await f(request);
		const text = await response.text();
		const rh: Record<string, string> = {};
		response.headers.forEach((v, k) => (rh[k] = v));
		opts.log.push({ req: { method: req.method!, url: req.url!, headers, body }, res: { status: response.status, headers: rh, body: text } });
		res.writeHead(response.status, rh);
		res.end(text);
	});
	await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
	const port = (srv.address() as any).port;
	return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => srv.close(() => r(null))) };
}
