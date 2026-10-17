import fs from 'node:fs';
import path from 'node:path';
import { buildFetch } from './server.ts';

const outDir = process.argv[2];
const f = buildFetch();

const WS = '00000000-0000-4000-8000-0000000000aa';
const ENVELOPE = {
	'io.modelcontextprotocol/protocolVersion': '2026-07-28',
	'io.modelcontextprotocol/clientInfo': { name: 'fixture-client', version: '1.0.0' },
	'io.modelcontextprotocol/clientCapabilities': {},
};
const base = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ank_fixture', 'X-Workspace-Id': WS };

type Case = { file: string; name: string; description: string; headers: Record<string, string>; body: any };
const cases: Case[] = [];
const calls: [string, string, string, any][] = [
	['tools-call-bad-argument', 'tools/call with an argument of the wrong type.', 'list_workspaces', { limit: 'ten' }],
	['tools-call-unknown-tool', 'tools/call for a tool that is not registered.', 'no_such_tool', {}],
	['tools-call-handler-throw', 'tools/call for a tool whose handler throws.', 'explode', {}],
];
let n = 1;
for (const era of ['legacy', 'modern'] as const) {
	let id = 1;
	for (const [slug, description, tool, args] of calls) {
		const params: any = { name: tool, arguments: args };
		const headers: Record<string, string> = { ...base };
		if (era === 'modern') {
			params._meta = ENVELOPE;
			headers['MCP-Protocol-Version'] = '2026-07-28';
			headers['Mcp-Method'] = 'tools/call';
			headers['Mcp-Name'] = tool;
		}
		cases.push({
			file: `${String(n++).padStart(2, '0')}-${era}-${slug}.json`,
			name: `${era}-${slug}`,
			description: `${description} ${era === 'legacy' ? 'Legacy leg: no per-request envelope, 2025-era JSON-RPC.' : 'Modern leg: 2026-07-28 envelope in params._meta plus the standard MCP headers.'}`,
			headers,
			body: { jsonrpc: '2.0', id: id++, method: 'tools/call', params },
		});
	}
}
fs.mkdirSync(outDir, { recursive: true });
for (const c of cases) {
	const bodyStr = JSON.stringify(c.body);
	const r = await f(new Request('http://x/mcp', { method: 'POST', headers: c.headers, body: bodyStr }));
	const text = await r.text();
	const out = {
		name: c.name,
		description: c.description,
		request: { method: 'POST', headers: c.headers, body: bodyStr },
		response: { status: r.status, contentType: r.headers.get('content-type'), body: text },
	};
	fs.writeFileSync(path.join(outDir, c.file), JSON.stringify(out, null, '\t') + '\n');
	console.log(c.file, r.status, r.headers.get('content-type'), text);
}
