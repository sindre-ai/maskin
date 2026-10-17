import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer, type Rec } from './wire.ts';

const log: Rec[] = [];
const seen: any[] = [];
const s = await startServer({ log, seen });

async function drive(label: string, versionNegotiation: any) {
	const c = new Client({ name: 'spike-client', version: '1.0.0' }, { versionNegotiation } as any);
	const t = new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { authorization: 'Bearer test-key', 'x-workspace-id': 'ws-1', 'x-maskin-session-id': 'sess-9' } } } as any);
	try {
		await c.connect(t as any);
		console.log(`[${label}] era=`, (c as any).getProtocolEra?.());
		const tl = await c.listTools();
		console.log(`[${label}] tools:`, tl.tools.map((x: any) => x.name).join(','));
		for (const [n, a] of [['add', { a: 'nope' }], ['no_such_tool', {}], ['boom', {}]] as const) {
			try {
				const r = await c.callTool({ name: n, arguments: a as any });
				console.log(`[${label}] ${n} ->`, JSON.stringify(r));
			} catch (e: any) {
				console.log(`[${label}] ${n} THROWN ->`, e?.constructor?.name, e?.code, e?.message);
			}
		}
	} catch (e: any) {
		console.log(`[${label}] connect failed`, e?.constructor?.name, e?.message);
	} finally { await c.close().catch(() => {}); }
}
await drive('legacy', { mode: 'legacy' });
await drive('auto', { mode: 'auto' });
await drive('pinned', { mode: { pin: '2026-07-28' } });
console.log('---- factory ctx seen (era + header keys):');
for (const x of seen) console.log(x.era, x.headers ? Object.keys(x.headers).filter(k => /authorization|x-|mcp|user-agent/.test(k)).join(',') : 'null');
import fs from 'node:fs';
fs.writeFileSync('/agent/workspace/spike/wire-log.json', JSON.stringify(log, null, 1));
console.log('recorded', log.length, 'exchanges');
await s.close();
