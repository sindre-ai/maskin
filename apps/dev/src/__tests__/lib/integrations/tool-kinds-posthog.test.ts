import { describe, expect, it } from 'vitest'
import {
	classifyCall,
	classifyPosthogCommand,
	classifyPosthogInnerTool,
	classifyTool,
	isCommandGated,
} from '../../../lib/integrations/tool-kinds'
import fixture from '../../fixtures/posthog-inner-tools.json'

const verdict = (command: unknown) => classifyPosthogCommand(command).kind

describe('classifyPosthogCommand', () => {
	it('reads a query, schema or lookup call', () => {
		expect(verdict('call query-trends {}')).toBe('read')
		expect(verdict('call read-data-schema {"kind":"events"}')).toBe('read')
		expect(verdict('call insights-list')).toBe('read')
		expect(verdict('call project-get {}')).toBe('read')
	})

	it('reads execute-sql because of the curated read set, not the token rules', () => {
		// "execute" is a write word, so the token rules alone would refuse it.
		expect(classifyPosthogInnerTool('execute-sql')).toBe('read')
		expect(verdict('call execute-sql {"query":"SELECT 1"}')).toBe('read')
		expect(verdict('call data-catalog-metric-run {}')).toBe('read')
	})

	it('names the inner tool of a call and never the input', () => {
		expect(classifyPosthogCommand('call dashboard-create {"name":"secret"}')).toEqual({
			kind: 'write',
			innerTool: 'dashboard-create',
		})
		const read = classifyPosthogCommand('call query-trends {"email":"a@b.c"}')
		expect(read.innerTool).toBe('query-trends')
		expect(JSON.stringify(read)).not.toContain('a@b.c')
	})

	it('refuses create, update and delete tools', () => {
		for (const name of [
			'dashboard-create',
			'feature-flag-update',
			'dashboard-delete',
			'feature-flags-partial-update',
			'agent-feedback',
		]) {
			expect(verdict(`call ${name} {}`)).toBe('write')
		}
	})

	it('refuses --confirm and any other flag, in any position', () => {
		expect(verdict('call --confirm query-trends {}')).toBe('write')
		expect(verdict('call --json --confirm query-trends {}')).toBe('write')
		expect(verdict('call --confirm --json query-trends {}')).toBe('write')
		expect(verdict('call --force query-trends {}')).toBe('write')
	})

	it('accepts --json before the tool name, in any amount of whitespace', () => {
		expect(verdict('call --json query-trends {}')).toBe('read')
		expect(verdict('call   --json \t query-trends   {}  ')).toBe('read')
		expect(verdict('call --json --json query-trends')).toBe('read')
	})

	it('refuses a flag after the tool name', () => {
		expect(verdict('call query-trends --json {}')).toBe('write')
		expect(verdict('call query-trends --confirm')).toBe('write')
	})

	it('refuses anything after the tool name that is not exactly one JSON value', () => {
		expect(verdict('call query-trends {} ; call dashboard-create {}')).toBe('write')
		expect(verdict('call query-trends {} && call dashboard-create {}')).toBe('write')
		expect(verdict('call query-trends {} | call dashboard-create {}')).toBe('write')
		expect(verdict('call query-trends ; call dashboard-create {}')).toBe('write')
		expect(verdict('call query-trends {} {}')).toBe('write')
		expect(verdict('call query-trends {} trailing')).toBe('write')
		expect(verdict('call query-trends {"a":1')).toBe('write')
	})

	it('accepts an object, an array, a scalar or nothing as the one JSON value', () => {
		expect(verdict('call query-trends {"a":[1,2]}')).toBe('read')
		expect(verdict('call query-trends [1,2]')).toBe('read')
		expect(verdict('call query-trends "x"')).toBe('read')
		expect(verdict('call query-trends')).toBe('read')
		expect(verdict('call query-trends   ')).toBe('read')
	})

	it('allows a separator character inside the JSON value, because it is one value', () => {
		expect(verdict('call execute-sql {"query":"SELECT 1; SELECT 2 && 3"}')).toBe('read')
	})

	it('refuses a tool name with a slash, a quote, upper case or a missing separator', () => {
		for (const command of [
			'call query/trends {}',
			'call "query-trends" {}',
			"call 'query-trends' {}",
			'call Query-Trends {}',
			'call query-trends{}',
			'call -query-trends {}',
			'call ',
			'call',
			'call --json',
		]) {
			expect(verdict(command)).toBe('write')
		}
	})

	it('reads a discovery command whose tail is letters, digits, spaces and hyphens', () => {
		for (const command of [
			'help',
			'tools',
			'search feature-flags',
			'info query-trends',
			'schema events',
			'learn funnels 2',
			'info --json query-trends',
		]) {
			expect(verdict(command)).toBe('read')
		}
	})

	it('refuses a discovery command with anything else after it', () => {
		for (const command of [
			'help ; call dashboard-create {}',
			'search a && b',
			'info $(x)',
			'tools | cat',
			'schema events > out',
			'search `x`',
			'help "x"',
			'help {}',
			'help\tx',
		]) {
			expect(verdict(command)).toBe('write')
		}
	})

	it('is case sensitive and refuses an unknown first token', () => {
		for (const command of [
			'CALL query-trends {}',
			'Help',
			'run query-trends',
			'callx a',
			'',
			' ',
		]) {
			expect(verdict(command)).toBe('write')
		}
		expect(verdict(' call query-trends {}')).toBe('write')
	})

	it('refuses a command that is not a string', () => {
		for (const command of [undefined, null, 1, true, {}, ['call query-trends {}']]) {
			expect(verdict(command)).toBe('write')
		}
	})

	it('refuses a newline, a carriage return and any other control character', () => {
		for (const command of [
			'call query-trends {}\ncall dashboard-create {}',
			'call query-trends {}\r\ncall dashboard-create {}',
			'help\nhelp',
			'call query-trends {}\u0000',
			'call query-trends\u000b{}',
			'call query-trends {} call dashboard-create {}',
			'call query-trends {}\u0085',
		]) {
			expect(verdict(command)).toBe('write')
		}
	})

	it('refuses a command over 100,000 characters', () => {
		expect(verdict(`call query-trends "${'x'.repeat(99_000)}"`)).toBe('read')
		expect(verdict(`call query-trends "${'x'.repeat(100_000)}"`)).toBe('write')
	})
})

describe('classifyPosthogInnerTool', () => {
	it('checks the curated set before the write words', () => {
		expect(classifyPosthogInnerTool('dashboard-insights-run')).toBe('read')
		expect(classifyPosthogInnerTool('endpoint-run')).toBe('write')
	})

	it('needs a read token and no write token', () => {
		expect(classifyPosthogInnerTool('feature-flag-get-all')).toBe('read')
		expect(classifyPosthogInnerTool('experiment-results-get')).toBe('read')
		expect(classifyPosthogInnerTool('feature-flag-get-or-create')).toBe('write')
		expect(classifyPosthogInnerTool('experiment-launch')).toBe('write')
		expect(classifyPosthogInnerTool('frobnicate')).toBe('write')
	})

	it('matches exact names only, never a prefix', () => {
		expect(classifyPosthogInnerTool('execute-sql-and-delete')).toBe('write')
		expect(classifyPosthogInnerTool('execute-sql2')).toBe('write')
		expect(classifyPosthogInnerTool('xexecute-sql')).toBe('write')
	})

	it('keeps a tool PostHog does not mark read-only a write, though its name reads', () => {
		expect(classifyPosthogInnerTool('workflows-data-suggestions-list')).toBe('write')
	})
})

describe('PostHog tool list fixture', () => {
	const entries = Object.entries(fixture.tools) as [string, [boolean, 'read' | 'write']][]

	it('holds the real tool list', () => {
		expect(entries.length).toBeGreaterThan(1000)
		for (const name of ['execute-sql', 'read-data-schema', 'dashboard-create', 'query-trends']) {
			expect(fixture.tools).toHaveProperty(name)
		}
	})

	it('gives every tool the verdict the fixture expects', () => {
		const wrong = entries
			.filter(([name, [, expected]]) => classifyPosthogInnerTool(name) !== expected)
			.map(([name]) => name)
		expect(wrong).toEqual([])
	})

	it('never reads a tool that PostHog does not mark read-only', () => {
		const unsafe = entries
			.filter(([, [upstreamReadOnly, expected]]) => expected === 'read' && !upstreamReadOnly)
			.map(([name]) => name)
		expect(unsafe).toEqual([])
	})

	it('never reads a tool with a write word in its name unless it is curated', () => {
		const curated = [
			'execute-sql',
			'data-catalog-metric-run',
			'dashboard-insights-run',
			'dashboard-widgets-run',
		]
		const reads = entries.filter(([, [, expected]]) => expected === 'read').map(([name]) => name)
		for (const name of reads) {
			if (curated.includes(name)) continue
			expect(name).not.toMatch(/(^|-)(create|update|delete|destroy|run|execute|send)(-|$)/)
		}
	})
})

describe('classifyCall', () => {
	const exec = (command: unknown) => ({ command })

	it('judges the command only for provider posthog and the tool name exec', () => {
		expect(isCommandGated('posthog', 'exec')).toBe(true)
		expect(classifyCall('posthog', 'exec', exec('call query-trends {}')).kind).toBe('read')
		expect(classifyCall('posthog', 'exec', exec('call dashboard-create {}')).kind).toBe('write')
	})

	it('refuses exec with missing or malformed arguments', () => {
		for (const args of [undefined, null, 'call query-trends {}', [], {}, { command: 1 }]) {
			expect(classifyCall('posthog', 'exec', args).kind).toBe('write')
		}
	})

	it('gives every other name and provider the old name rules, whatever the command says', () => {
		for (const [provider, name] of [
			['posthog', 'EXEC'],
			['posthog', 'exec '],
			['posthog', ' exec'],
			['posthog', 'exec2'],
			['posthog', 'exec-sql'],
			['posthog', 'query'],
			['linear', 'exec'],
			['custom-mcp', 'exec'],
			['gmail', 'exec'],
		]) {
			expect(isCommandGated(provider, name)).toBe(false)
			expect(classifyCall(provider, name, exec('call query-trends {}'))).toEqual({
				kind: classifyTool(provider, name),
			})
		}
		expect(classifyTool('posthog', 'exec')).toBe('write')
	})

	it('does not let the server’s own hint turn exec into a read', () => {
		const hinted = { readOnlyHint: true }
		expect(classifyCall('posthog', 'exec', exec('call dashboard-create {}'), hinted).kind).toBe(
			'write',
		)
	})

	it('leaves other providers’ calls on classifyTool, with their annotations', () => {
		expect(classifyCall('linear', 'list_issues', {}).kind).toBe('read')
		expect(classifyCall('linear', 'create_issue', {}).kind).toBe('write')
		expect(classifyCall('linear', 'frobnicate', {}, { readOnlyHint: true }).kind).toBe('read')
	})
})
