import { buildFetch } from './server.ts';
const f = buildFetch();
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const ENV = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
async function go(label: string, init: RequestInit) {
	const r = await f(new Request('http://x/mcp', init));
	const t = (init.method==="GET"||init.method==="DELETE") && r.headers.get("content-type")?.includes("event-stream") ? "[stream, body not read]" : await r.text();
	console.log(`### ${label}\n${r.status} ${r.headers.get('content-type')} ${JSON.stringify(Object.fromEntries([...r.headers].filter(([k]) => k !== 'content-type')))}\n${t.slice(0, 900)}\n`);
}
await go('Q2 legacy batch array', { method: 'POST', headers: H, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'ping' }]) });
await go('Q2 legacy notification', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
await go('Q2 legacy GET', { method: 'GET', headers: { accept: 'text/event-stream' } });
await go('Q2 legacy DELETE', { method: 'DELETE', headers: H });
await go('Q2 legacy malformed JSON', { method: 'POST', headers: H, body: '{not json' });
await go('Q5 modern server/discover', { method: 'POST', headers: { ...H, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: ENV } }) });
await go('Q5 modern tools/list', { method: 'POST', headers: { ...H, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: ENV } }) });
await go('modern unsupported version', { method: 'POST', headers: { ...H, 'MCP-Protocol-Version': '2099-01-01', 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { ...ENV, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } }) });
await go('modern header only, no envelope', { method: 'POST', headers: { ...H, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }) });
await go('modern header mismatch (Mcp-Method)', { method: 'POST', headers: { ...H, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: ENV } }) });
await go('modern GET', { method: 'GET', headers: { accept: 'text/event-stream', 'MCP-Protocol-Version': '2026-07-28' } });
await go('modern nested bad arg + 2 issues', { method: 'POST', headers: { ...H, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'list_workspaces' }, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'list_workspaces', arguments: { limit: 0, cursor: 5, extra: 1 }, _meta: ENV } }) });
await go('legacy app_add ok (registerAppTool via adapter)', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'app_add', arguments: { a: 3 } } }) });
await go('legacy app_add bad arg', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'app_add', arguments: {} } }) });

process.exit(0);
