import { describe, expect, it } from 'vitest'
import { annotateToolsList, decideToolCall } from '../../../lib/integrations/mcp-gateway'
import { POSTHOG_READ_TOOLS } from '../../../lib/integrations/posthog-read-tools'
import { classifyCall, classifyTool, isPosthogExec } from '../../../lib/integrations/tool-kinds'
import catalog from '../../fixtures/posthog-tool-catalog.json'

const kindOf = (command: unknown) => classifyCall('posthog', 'exec', { command }).kind

describe('PostHog exec: which commands a read-only agent may run', () => {
	it('reads: inner tools in the curated set, with and without input and flags', () => {
		expect(kindOf('call query-trends {}')).toBe('read')
		expect(kindOf('call query-trends {"series":[{"event":"$pageview"}]}')).toBe('read')
		expect(kindOf('call --json read-data-schema {"query":{"kind":"events"}}')).toBe('read')
		expect(kindOf('call insights-list')).toBe('read')
		expect(kindOf('call insights-list [1, 2]')).toBe('read')
		expect(kindOf('call\tquery-trends\t{}')).toBe('read')
		expect(classifyCall('posthog', 'exec', { command: 'call query-trends {}' }).commandTool).toBe(
			'query-trends',
		)
	})

	// The old name rules treat "execute" and "run" as write words; the curated set comes first.
	it('reads execute-sql and data-catalog-metric-run because they are in the curated set', () => {
		expect(classifyTool('posthog', 'execute-sql')).toBe('write')
		expect(POSTHOG_READ_TOOLS.has('execute-sql')).toBe(true)
		expect(kindOf('call execute-sql {"query":"select 1"}')).toBe('read')
		expect(kindOf('call data-catalog-metric-run {}')).toBe('read')
	})

	it('reads the discovery commands', () => {
		for (const c of ['help', 'help call', 'tools', 'search feature-flags', 'info query-trends']) {
			expect(kindOf(c)).toBe('read')
		}
		expect(kindOf('info --json query-trends')).toBe('read')
		expect(kindOf('schema query-trends series')).toBe('read')
		expect(kindOf('learn querying-posthog-data')).toBe('read')
	})

	it('refuses creates, updates, deletes and tools nobody classified', () => {
		for (const name of [
			'dashboard-create',
			'feature-flag-update',
			'feature-flags-partial-update',
			'insights-destroy',
			'agent-feedback',
			'organization-enforce-2fa-prepare',
			'some-brand-new-tool',
			'workflows-data-suggestions-list',
		]) {
			const verdict = classifyCall('posthog', 'exec', { command: `call ${name} {}` })
			expect(verdict).toEqual({ kind: 'write', commandTool: name })
		}
	})

	it('refuses --confirm and any other flag, before or after the tool name', () => {
		expect(kindOf('call --confirm query-trends {}')).toBe('write')
		expect(kindOf('call --json --confirm query-trends {}')).toBe('write')
		expect(kindOf('call --force query-trends {}')).toBe('write')
		expect(kindOf('call query-trends --json {}')).toBe('write')
		expect(kindOf('call query-trends --confirm {}')).toBe('write')
	})

	it('refuses a command that is not a single known command', () => {
		for (const c of [
			undefined,
			null,
			42,
			{ command: 'help' },
			['help'],
			'',
			' help',
			'HELP',
			'Call query-trends {}',
			'call',
			'call ',
			'call --json',
			'run query-trends {}',
			'exec help',
			'help\ncall dashboard-create {}',
			'call query-trends {}\ncall dashboard-create {}',
			'call query-trends {}\r\ncall dashboard-create {}',
			'call query-trends {} call dashboard-create {}',
			'call query-trends {}\u0000',
			`call query-trends {"x":"${'a'.repeat(100_001)}"}`,
		]) {
			expect(kindOf(c)).toBe('write')
		}
		// No arguments object at all, or one without a command.
		expect(classifyCall('posthog', 'exec', undefined).kind).toBe('write')
		expect(classifyCall('posthog', 'exec', null).kind).toBe('write')
		expect(classifyCall('posthog', 'exec', []).kind).toBe('write')
		expect(classifyCall('posthog', 'exec', {}).kind).toBe('write')
	})

	it('refuses a tool name that is not plain kebab-case', () => {
		for (const name of [
			'Query-trends',
			'query_trends',
			'query-trends{}',
			'-query',
			'a/b',
			"a'b",
			'a;b',
		]) {
			expect(kindOf(`call ${name} {}`)).toBe('write')
		}
	})

	it('refuses anything chained after the tool name', () => {
		for (const c of [
			'call query-trends {} ; call dashboard-create {}',
			'call query-trends {} && call dashboard-create {}',
			'call query-trends {} | call dashboard-create {}',
			'call query-trends {} {}',
			'call query-trends ; call dashboard-create {}',
			'call query-trends && call dashboard-create {}',
			'call query-trends {',
			'call query-trends {} x',
			'call query-trends x',
		]) {
			expect(kindOf(c)).toBe('write')
		}
	})

	it('accepts exactly one JSON value as input: object, array, string, number, or none', () => {
		for (const input of ['{}', '[]', '[1,2]', '"x"', '12', 'true', 'null', '  {"a": 1}  ', '']) {
			expect(kindOf(`call query-trends ${input}`)).toBe('read')
		}
	})

	it('allows only letters, digits, spaces and hyphens after a discovery command', () => {
		for (const c of [
			'help ; call dashboard-create {}',
			'search a && b',
			'info $(x)',
			'tools | cat',
			'tools > out',
			'info `x`',
			'search "x"',
			'schema query-trends series.0',
			'help call;',
			'helpcall',
			'tools-all',
		]) {
			expect(kindOf(c)).toBe('write')
		}
	})

	it('judges the exec rule only for provider posthog and the exact name exec', () => {
		expect(isPosthogExec('posthog', 'exec')).toBe(true)
		for (const [provider, name] of [
			['posthog', 'EXEC'],
			['posthog', 'exec '],
			['posthog', 'exec2'],
			['posthog', 'exec-sql'],
			['posthog', 'query'],
			['linear', 'exec'],
			['custom-mcp', 'exec'],
		] as const) {
			expect(isPosthogExec(provider, name)).toBe(false)
			// The same call, with a command that would read, is judged by the old name rules.
			expect(classifyCall(provider, name, { command: 'help' })).toEqual({
				kind: classifyTool(provider, name),
			})
		}
		expect(classifyCall('posthog', 'EXEC', { command: 'help' }).kind).toBe('write')
		expect(classifyCall('linear', 'exec', { command: 'help' }).kind).toBe('write')
		expect(classifyCall('linear', 'list_issues', {}).kind).toBe('read')
	})

	it('does not let the server’s read-only hint make exec a read', () => {
		const verdict = classifyCall(
			'posthog',
			'exec',
			{ command: 'call dashboard-create {}' },
			{ readOnlyHint: true },
		)
		expect(verdict.kind).toBe('write')
	})
})

describe('PostHog tool catalog (fixture from PostHog’s own tool list)', () => {
	const entries = Object.entries(catalog as Record<string, [boolean, boolean]>)
	// Left out of the curated set on purpose although PostHog marks them read-only.
	const leftOut = (name: string) =>
		name.endsWith('-prepare') ||
		[
			'agent-feedback',
			'data-warehouse-source-connect-link',
			'external-data-sources-check-cdc-prerequisites-create',
		].includes(name)

	it('has the catalog the curated set was taken from', () => {
		expect(entries.length).toBeGreaterThan(1000)
		expect(catalog).toHaveProperty('execute-sql')
	})

	it('reads exactly the tools PostHog marks read-only and not destructive, minus the left-out ones', () => {
		const wrong: string[] = []
		for (const [name, [readOnly, destructive]] of entries) {
			const expected = readOnly && !destructive && !leftOut(name) ? 'read' : 'write'
			const got = classifyCall('posthog', 'exec', { command: `call ${name} {}` }).kind
			if (got !== expected) wrong.push(`${name}: expected ${expected}, got ${got}`)
		}
		expect(wrong).toEqual([])
	})

	it('has every curated name in the catalog, read-only and not destructive', () => {
		for (const name of POSTHOG_READ_TOOLS) {
			const entry = (catalog as Record<string, [boolean, boolean]>)[name]
			expect(entry, name).toBeDefined()
			expect(entry?.[0], name).toBe(true)
			expect(entry?.[1], name).toBe(false)
		}
	})
})

describe('decideToolCall for PostHog exec', () => {
	const base = { provider: 'posthog', providerLabel: 'PostHog', toolName: 'exec' }

	it('lets a read agent run a query and refuses it a create, naming the inner tool', () => {
		const query = { command: 'call query-trends {}' }
		expect(decideToolCall({ ...base, args: query, access: 'read' }).allowed).toBe(true)
		const denied = decideToolCall({
			...base,
			args: { command: 'call dashboard-create {"name":"private"}' },
			access: 'read',
		})
		expect(denied.allowed).toBe(false)
		expect(denied.commandTool).toBe('dashboard-create')
		expect(denied.message).toContain('exec (dashboard-create) needs write access to PostHog')
		expect(denied.message).not.toContain('private')
	})

	it('lets a read & write agent do the create and an agent with none do nothing', () => {
		const create = { command: 'call dashboard-create {}' }
		const query = { command: 'call query-trends {}' }
		expect(decideToolCall({ ...base, args: create, access: 'read_write' }).allowed).toBe(true)
		expect(decideToolCall({ ...base, args: query, access: 'none' }).allowed).toBe(false)
		expect(decideToolCall({ ...base, args: create, access: 'none' }).allowed).toBe(false)
	})

	it('refuses exec called with no arguments', () => {
		expect(decideToolCall({ ...base, access: 'read' }).allowed).toBe(false)
	})
})

describe('annotateToolsList for PostHog exec', () => {
	const result = { tools: [{ name: 'exec', description: 'Run a command.' }] }
	const ctx = { provider: 'posthog', providerLabel: 'PostHog' }
	const first = (out: Record<string, unknown>) =>
		(out as { tools: Array<{ description: string; annotations: { readOnlyHint: boolean } }> })
			.tools[0]

	it('lists exec as usable for a read agent, still not read-only, with a note on what runs', () => {
		const tool = first(annotateToolsList(result, { ...ctx, access: 'read' }).result)
		expect(tool.description).not.toContain('Unavailable')
		expect(tool.description).toContain('Read access: query and lookup commands run')
		expect(tool.annotations.readOnlyHint).toBe(false)
	})

	it('adds nothing for a read & write agent and marks it unavailable for none', () => {
		const rw = first(annotateToolsList(result, { ...ctx, access: 'read_write' }).result)
		expect(rw.description).toBe('Run a command.')
		const none = first(annotateToolsList(result, { ...ctx, access: 'none' }).result)
		expect(none.description).toContain('[Unavailable: you have no access to PostHog.]')
	})

	it('leaves a tool named exec on another provider under the old rules', () => {
		const linear = { provider: 'linear', providerLabel: 'Linear', access: 'read' as const }
		const tool = first(annotateToolsList(result, linear).result)
		expect(tool.description).toContain('[Unavailable: needs write access to Linear')
	})
})
