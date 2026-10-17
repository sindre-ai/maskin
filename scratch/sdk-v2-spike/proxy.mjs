import http from 'node:http';
const target = 'http://127.0.0.1:3000';
http.createServer(async (req, res) => {
	const chunks = []; for await (const c of req) chunks.push(c);
	const body = Buffer.concat(chunks);
	let rpc = ''; try { const j = JSON.parse(body.toString()); rpc = Array.isArray(j) ? 'BATCH' : j.method; } catch {}
	const r = await fetch(target + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host' && k !== 'content-length')), body: ['GET','HEAD'].includes(req.method) ? undefined : body });
	const text = await r.text();
	console.log(JSON.stringify({ http: req.method, rpc, ua: req.headers['user-agent'], pv: req.headers['mcp-protocol-version'], status: r.status, res: text.slice(0, 140) }));
	res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding','transfer-encoding','content-length'].includes(k)))); res.end(text);
}).listen(8766, '127.0.0.1', () => console.log('proxy up'));
