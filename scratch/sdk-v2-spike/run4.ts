import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';
const s = new McpServer({ name: 'x', version: '1' });
try {
	s.registerTool('raw', { inputSchema: z.object({ a: z.number() }).shape } as any, async (args: any) => ({ content: [{ type: 'text', text: String(args.a) }] }));
	const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as any);
	await s.connect(t as any);
	const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
	for (const [id, method, params] of [[1, 'tools/list', undefined], [2, 'tools/call', { name: 'raw', arguments: { a: 2 } }]] as const) {
		const r = await t.handleRequest(new Request('http://x/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
		console.log(method, r.status, (await r.text()).slice(0, 500));
	}
} catch (e: any) { console.log('registration/runtime threw:', e?.message?.slice(0, 400)); }
process.exit(0);
