import { buildFetch } from './server.ts';
const f = buildFetch();
async function post(label: string, body: any, headers: Record<string,string> = {}) {
	const r = await f(new Request('http://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) }));
	const text = await r.text();
	console.log('=== ' + label, r.status, r.headers.get('content-type'));
	console.log(text);
}
await post('legacy initialize', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
await post('legacy tools/list', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
await post('legacy bad arg', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add', arguments: { a: 'nope' } } });
