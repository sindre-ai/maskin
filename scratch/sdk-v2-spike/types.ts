import { McpServer } from '@modelcontextprotocol/server';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { toStandardSchemaTyped } from './adapter-typed.ts';

const s = new McpServer({ name: 'x', version: '1' });
const input = z.object({ a: z.number(), b: z.number().default(1) });

// 1. registerTool, no casts
s.registerTool('t1', { inputSchema: toStandardSchemaTyped(input) }, async (args) => {
	const n: number = args.a + args.b; // args typed from Zod 3 output
	return { content: [{ type: 'text', text: String(n) }] };
});

// 2. ext-apps registerAppTool, no casts
registerAppTool(s, 't2', { inputSchema: toStandardSchemaTyped(input), _meta: { ui: { resourceUri: 'ui://x' } } }, async (args) => {
	const n: number = args.a + args.b;
	return { content: [{ type: 'text', text: String(n) }] };
});

// 3. raw Zod 3 shape (what the repo does today) -- expected to be rejected or mis-typed
s.registerTool('t3', { inputSchema: input.shape }, async (args) => ({ content: [{ type: 'text', text: String(args.a) }] }));
registerAppTool(s, 't4', { inputSchema: input.shape, _meta: { ui: { resourceUri: 'ui://x' } } }, async (args) => ({ content: [{ type: 'text', text: String(args.a) }] }));
