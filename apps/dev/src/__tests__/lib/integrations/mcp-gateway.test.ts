import { describe, expect, it } from 'vitest'
import {
	GATEWAY_PROVIDERS,
	annotateToolsList,
	buildUpstreamHeaders,
	decideToolCall,
	denialResult,
	gatewayServerSpec,
	parseJsonRpc,
	parseSseData,
	rewriteMcpServersForGateway,
	toSse,
	toolsCallName,
} from '../../../lib/integrations/mcp-gateway'

const UPSTREAMS = new Map([
	['linear', 'https://mcp.linear.app/mcp'],
	['gmail', 'https://gmailmcp.googleapis.com/mcp/v1'],
])

describe('GATEWAY_PROVIDERS', () => {
	it('is exactly the hosted-HTTP providers, not the ones Maskin hosts or that need the token in the container', () => {
		expect([...GATEWAY_PROVIDERS].sort()).toEqual([
			'gmail',
			'google-calendar',
			'linear',
			'posthog',
			'resend',
			'ubersuggest',
		])
		for (const other of ['slack', 'github', 'linkedin-unipile', 'google-meet']) {
			expect(GATEWAY_PROVIDERS.has(other)).toBe(false)
		}
	})
})

describe('gatewayServerSpec', () => {
	it('authenticates with the agent’s Maskin key and never a provider token', () => {
		const spec = gatewayServerSpec('linear') as {
			url: string
			headers: Record<string, string>
		}
		expect(spec.url).toBe('${MASKIN_API_URL}/api/integrations/linear/gateway')
		expect(spec.headers.Authorization).toBe('Bearer ${MASKIN_API_KEY}')
		expect(JSON.stringify(spec)).not.toContain('LINEAR_TOKEN')
	})
})

describe('rewriteMcpServersForGateway', () => {
	it('points an entry at the gateway when its URL is the provider’s own server, whatever the key', () => {
		const { servers, rewritten } = rewriteMcpServersForGateway(
			{
				linear: {
					type: 'http',
					url: 'https://mcp.linear.app/mcp',
					headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
				},
				'my-renamed-mail': { type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1/' },
			},
			UPSTREAMS,
		)
		expect(rewritten.sort()).toEqual(['linear', 'my-renamed-mail'])
		expect(servers?.linear).toEqual(gatewayServerSpec('linear'))
		expect(servers?.['my-renamed-mail']).toEqual(gatewayServerSpec('gmail'))
		expect(JSON.stringify(servers)).not.toContain('_TOKEN')
	})

	it('leaves other servers exactly as they were', () => {
		const other = { type: 'http', url: 'https://example.test/mcp' }
		const stdio = { type: 'stdio', command: 'npx', args: ['-y', 'thing'] }
		const { servers, rewritten } = rewriteMcpServersForGateway({ other, stdio }, UPSTREAMS)
		expect(rewritten).toEqual([])
		expect(servers).toEqual({ other, stdio })
	})

	it('passes through a missing map', () => {
		expect(rewriteMcpServersForGateway(undefined, UPSTREAMS).servers).toBeUndefined()
	})
})

describe('JSON-RPC parsing', () => {
	it('reads one message, and refuses batches and junk', () => {
		const ok = parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}')
		expect(ok).toMatchObject({ ok: true })
		expect(parseJsonRpc('[{"id":1}]')).toEqual({ ok: false, reason: 'batch' })
		expect(parseJsonRpc('nope')).toEqual({ ok: false, reason: 'invalid' })
		expect(parseJsonRpc('"a string"')).toEqual({ ok: false, reason: 'invalid' })
	})

	it('names the tool of a tools/call and nothing else', () => {
		expect(toolsCallName({ method: 'tools/call', params: { name: 'create_issue' } })).toBe(
			'create_issue',
		)
		expect(toolsCallName({ method: 'tools/list' })).toBeNull()
		expect(toolsCallName({ method: 'tools/call', params: {} })).toBeNull()
		expect(toolsCallName({ method: 'tools/call', params: { name: '' } })).toBeNull()
	})

	it('answers a refusal as a failed tool result carrying the request id', () => {
		expect(denialResult(7, 'no')).toEqual({
			jsonrpc: '2.0',
			id: 7,
			result: { isError: true, content: [{ type: 'text', text: 'no' }] },
		})
		expect(denialResult(undefined, 'no').id).toBeNull()
	})
})

describe('decideToolCall', () => {
	const base = { provider: 'linear', providerLabel: 'Linear' }

	it('lets a read-only agent read and refuses it a write, with the reason', () => {
		expect(decideToolCall({ ...base, toolName: 'list_issues', access: 'read' }).allowed).toBe(true)
		const denied = decideToolCall({ ...base, toolName: 'create_issue', access: 'read' })
		expect(denied.allowed).toBe(false)
		expect(denied.kind).toBe('write')
		expect(denied.message).toContain('create_issue needs write access to Linear')
	})

	it('lets a read & write agent do both and an agent with none do neither', () => {
		for (const toolName of ['list_issues', 'create_issue']) {
			expect(decideToolCall({ ...base, toolName, access: 'read_write' }).allowed).toBe(true)
			expect(decideToolCall({ ...base, toolName, access: 'none' }).allowed).toBe(false)
		}
	})

	it('uses what the server said about the tool, but only toward read', () => {
		const hinted = { readOnlyHint: true }
		expect(decideToolCall({ ...base, toolName: 'frobnicate', access: 'read' }).allowed).toBe(false)
		expect(
			decideToolCall({ ...base, toolName: 'frobnicate', access: 'read', annotations: hinted })
				.allowed,
		).toBe(true)
		expect(
			decideToolCall({
				...base,
				toolName: 'get_thing',
				access: 'read',
				annotations: { destructiveHint: true },
			}).allowed,
		).toBe(false)
	})
})

describe('decideToolCall for PostHog exec', () => {
	const base = { provider: 'posthog', providerLabel: 'PostHog', toolName: 'exec' }
	const command = (c: string) => ({ command: c })

	it('lets a read-only agent run a query and refuses a write, naming the inner tool', () => {
		const read = decideToolCall({ ...base, args: command('call query-trends {}'), access: 'read' })
		expect(read).toMatchObject({ allowed: true, kind: 'read', innerTool: 'query-trends' })

		const denied = decideToolCall({
			...base,
			args: command('call dashboard-create {"name":"x"}'),
			access: 'read',
		})
		expect(denied.allowed).toBe(false)
		expect(denied.innerTool).toBe('dashboard-create')
		expect(denied.message).toContain('exec (dashboard-create) needs write access to PostHog')
		expect(denied.message).toContain('one query or lookup command per call')
		expect(denied.message).not.toContain('"name"')
	})

	it('refuses with no inner tool when the command does not parse', () => {
		const denied = decideToolCall({ ...base, args: command('help ; call x {}'), access: 'read' })
		expect(denied).toMatchObject({ allowed: false, kind: 'write' })
		expect(denied.innerTool).toBeUndefined()
		expect(denied.message).toContain('exec needs write access to PostHog')
	})

	it('lets read & write do the write and refuses everything at no access', () => {
		const write = command('call dashboard-create {}')
		const read = command('call query-trends {}')
		expect(decideToolCall({ ...base, args: write, access: 'read_write' }).allowed).toBe(true)
		expect(decideToolCall({ ...base, args: read, access: 'none' }).allowed).toBe(false)
		expect(decideToolCall({ ...base, args: write, access: 'none' }).allowed).toBe(false)
	})

	it('leaves the message of every other tool as it was', () => {
		const denied = decideToolCall({
			provider: 'linear',
			providerLabel: 'Linear',
			toolName: 'create_issue',
			args: command('call query-trends {}'),
			access: 'read',
		})
		expect(denied.message).not.toContain('one query or lookup command')
		expect(denied.innerTool).toBeUndefined()
	})
})

describe('annotateToolsList for PostHog exec', () => {
	const result = { tools: [{ name: 'exec', description: 'Run a command.' }] }
	type Listed = { tools: Array<{ description: string; annotations: { readOnlyHint: boolean } }> }
	const annotate = (access: 'none' | 'read' | 'read_write') => {
		const ctx = { provider: 'posthog', providerLabel: 'PostHog', access }
		return (annotateToolsList(result, ctx).result as Listed).tools[0]
	}

	it('lists exec as usable to a read-only agent, says which commands run, and stays not read-only', () => {
		const tool = annotate('read')
		expect(tool.description).not.toContain('Unavailable')
		expect(tool.description).toBe(
			'Run a command. Read access: query and lookup commands run; create, update and delete commands are refused.',
		)
		expect(tool.annotations.readOnlyHint).toBe(false)
	})

	it('still shows exec as unavailable at no access', () => {
		const tool = annotate('none')
		expect(tool.description).toContain('[Unavailable: you have no access to PostHog.]')
		expect(tool.annotations.readOnlyHint).toBe(false)
	})

	it('adds nothing for a read & write agent', () => {
		const tool = annotate('read_write')
		expect(tool.description).toBe('Run a command.')
		expect(tool.annotations.readOnlyHint).toBe(false)
	})

	it('treats exec of another provider, or another name on PostHog, by the old rules', () => {
		const execTool = { tools: [{ name: 'exec', description: 'x' }] }
		const upperTool = { tools: [{ name: 'EXEC', description: 'y' }] }
		const linear = { provider: 'linear', providerLabel: 'Linear', access: 'read' as const }
		const posthog = { provider: 'posthog', providerLabel: 'PostHog', access: 'read' as const }
		const onLinear = annotateToolsList(execTool, linear).result as Listed
		const onPosthog = annotateToolsList(upperTool, posthog).result as Listed
		expect(onLinear.tools[0].description).toContain('[Unavailable: needs write access to Linear')
		expect(onPosthog.tools[0].description).toContain('[Unavailable: needs write access to PostHog')
	})
})

describe('annotateToolsList', () => {
	const result = {
		tools: [
			{ name: 'list_issues', description: 'List issues.' },
			{ name: 'create_issue', description: 'Create an issue.', annotations: { title: 'Create' } },
			{ name: 'frobnicate', description: 'Hinted.', annotations: { readOnlyHint: true } },
		],
		nextCursor: 'c1',
	}

	it('marks every tool read-only or not and flags the ones this agent cannot use', () => {
		const { result: out } = annotateToolsList(result, {
			provider: 'linear',
			providerLabel: 'Linear',
			access: 'read',
		})
		const tools = (
			out as {
				tools: Array<{ description: string; annotations: Record<string, unknown> }>
			}
		).tools
		expect(tools[0].description).toBe('List issues.')
		expect(tools[0].annotations.readOnlyHint).toBe(true)
		expect(tools[1].description).toContain('[Unavailable: needs write access to Linear')
		expect(tools[1].annotations).toMatchObject({ title: 'Create', readOnlyHint: false })
		expect(tools[2].annotations.readOnlyHint).toBe(true)
		// Everything else on the result is kept.
		expect((out as { nextCursor: string }).nextCursor).toBe('c1')
	})

	it('flags nothing for a read & write agent', () => {
		const { result: out } = annotateToolsList(result, {
			provider: 'linear',
			providerLabel: 'Linear',
			access: 'read_write',
		})
		const tools = (out as { tools: Array<{ description: string }> }).tools
		expect(tools.every((t) => !t.description.includes('Unavailable'))).toBe(true)
	})

	it('hands back what the server itself said, to classify later calls with', () => {
		const { upstreamAnnotations } = annotateToolsList(result, {
			provider: 'linear',
			providerLabel: 'Linear',
			access: 'read',
		})
		expect(upstreamAnnotations.get('frobnicate')).toEqual({ readOnlyHint: true })
		expect(upstreamAnnotations.has('list_issues')).toBe(false)
	})
})

describe('server-sent events', () => {
	it('round-trips messages and ignores keep-alive comments', () => {
		const messages = [{ jsonrpc: '2.0', id: 1, result: { tools: [] } }]
		const body = `: keep-alive\n\n${toSse(messages)}`
		expect(parseSseData(body)).toEqual(messages)
	})

	it('joins a multi-line data field', () => {
		expect(parseSseData('data: {"a":\ndata: 1}\n\n')).toEqual([{ a: 1 }])
	})
})

describe('buildUpstreamHeaders', () => {
	it('fills the token template and nothing else', () => {
		expect(
			buildUpstreamHeaders({ Authorization: 'Bearer ${LINEAR_TOKEN}' }, 'LINEAR_TOKEN', 'tok-1'),
		).toEqual({ Authorization: 'Bearer tok-1' })
	})

	it('drops a header whose placeholder it cannot fill instead of sending it as text', () => {
		expect(
			buildUpstreamHeaders(
				{ Authorization: 'Bearer ${LINEAR_TOKEN}', 'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}' },
				'LINEAR_TOKEN',
				'tok-1',
			),
		).toEqual({ Authorization: 'Bearer tok-1' })
		expect(buildUpstreamHeaders(undefined, 'LINEAR_TOKEN', 'tok-1')).toEqual({})
	})
})
