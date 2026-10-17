import { makeServer } from './server.ts';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
// Flag-off simulation: ALL requests (including modern) go to the legacy leg.
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const ENV = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
async function legacyLeg(headers: Record<string, string>, body: any) {
	const server = makeServer({ era: 'legacy' });
	const t = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as any);
	await server.connect(t as any);
	const r = await t.handleRequest(new Request('http://x/mcp', { method: 'POST', headers: { ...H, ...headers }, body: JSON.stringify(body) }), { parsedBody: body } as any);
	console.log(r.status, r.headers.get('content-type'), (await r.text()).slice(0, 300));
}
console.log('# flag-off: discover with header+envelope'); await legacyLeg({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' }, { jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: { _meta: ENV } });
console.log('# flag-off: tools/list with header+envelope'); await legacyLeg({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: ENV } });
console.log('# flag-off: bare discover (no header)'); await legacyLeg({}, { jsonrpc: '2.0', id: 2, method: 'server/discover' });
process.exit(0);
