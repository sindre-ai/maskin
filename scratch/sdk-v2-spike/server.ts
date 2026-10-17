import { McpServer, createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { toStandardSchema } from './adapter.ts';
// Real create_loop input schema (has .strict() branches), for the unrecognized-key case.
const { tools: realTools } = await import(process.env.TOOLS_PATH ?? '../../packages/mcp/src/tools.ts');

export function makeServer(ctx?: any, seen?: any[]) {
	if (seen) seen.push({ era: ctx?.era, headers: ctx?.requestInfo ? Object.fromEntries(ctx.requestInfo.headers) : null });
	const s = new McpServer({ name: 'spike', version: '0.0.1' }, {
		capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
	} as any);
	s.registerTool('list_workspaces', {
		description: 'List workspaces (scratch copy of the real schema from packages/mcp/src/tools.ts)',
		inputSchema: toStandardSchema(z.object({
			limit: z.number().int().min(1).max(100).optional().describe('Max rows to return. Defaults to 25.'),
			cursor: z.string().optional().describe('Opaque cursor.'),
		})),
	} as any, async () => ({ content: [{ type: 'text', text: JSON.stringify({ workspaces: [{ id: '00000000-0000-4000-8000-0000000000aa', name: 'Fixture workspace', role: 'owner' }] }) }] }));
	s.registerTool('create_loop', {
		description: 'Scratch registration of the real create_loop input schema',
		inputSchema: toStandardSchema(realTools.create_loop.inputSchema),
	} as any, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
	s.registerTool('explode', {
		description: 'Scratch tool whose handler always throws',
		inputSchema: toStandardSchema(z.object({})),
	} as any, async () => { throw new Error('handler exploded: upstream API returned 500'); });
	// ext-apps registerAppTool with the adapter
	(registerAppTool as any)(s, 'app_add', {
		description: 'App tool',
		inputSchema: toStandardSchema(z.object({ a: z.number() })),
		_meta: { ui: { resourceUri: 'ui://spike/app.html' } },
	}, async (args: any) => ({ content: [{ type: 'text', text: String(args.a) }] }));
	return s;
}

export function buildFetch(seen?: any[]) {
	const factory = (ctx: any) => makeServer(ctx, seen);
	const modern = createMcpHandler(factory as any, { legacy: 'reject' });
	return async (request: Request): Promise<Response> => {
		let parsed: any;
		if (request.method === 'POST') {
			try { parsed = await request.clone().json(); } catch { parsed = undefined; }
		}
		if (await isLegacyRequest(request, parsed)) {
			const server = makeServer({ era: 'legacy', requestInfo: request }, seen);
			const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as any);
			await server.connect(transport as any);
			return transport.handleRequest(request, { parsedBody: parsed } as any);
		}
		return modern.fetch(request, { parsedBody: parsed });
	};
}
