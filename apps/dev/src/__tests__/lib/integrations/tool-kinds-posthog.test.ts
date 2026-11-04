import { describe, expect, it } from 'vitest'
import {
	classifyCall,
	classifyPosthogCommand,
	classifyPosthogInnerTool,
	classifyTool,
	isCommandGated,
} from '../../../lib/integrations/tool-kinds'

const verdict = (command: unknown) => classifyPosthogCommand(command).kind

/**
 * Real inner tool names from PostHog's tool list with the verdict a Read agent should get.
 * A small sample, not the catalog: a read verdict only where PostHog marks the tool
 * read-only too, and a few reads left as writes on purpose (fail closed).
 */
const SAMPLE: Record<string, 'read' | 'write'> = {
	// curated read set (a write word in the name, or a run that only reads)
	'execute-sql': 'read',
	'data-catalog-metric-run': 'read',
	'dashboard-insights-run': 'read',
	'dashboard-widgets-run': 'read',
	// read tokens
	'query-trends': 'read',
	'query-funnel': 'read',
	'query-logs': 'read',
	'read-data-schema': 'read',
	'docs-search': 'read',
	'project-get': 'read',
	'insights-list': 'read',
	'cohorts-list': 'read',
	'persons-list': 'read',
	'feature-flag-get-all': 'read',
	'experiment-results-get': 'read',
	'logs-alerts-retrieve': 'read',
	'billing-products-summary-get': 'read',
	'integration-get': 'read',
	// write words
	'dashboard-create': 'write',
	'dashboard-delete': 'write',
	'event-definition-update': 'write',
	'annotation-create': 'write',
	'alert-delete': 'write',
	'custom-property-definitions-destroy': 'write',
	'products-enable': 'write',
	'experiment-launch': 'write',
	'autoresearch-partial-update': 'write',
	'access-control-default-rule-set-execute': 'write',
	// no read token, or sends something
	'agent-feedback': 'write',
	'endpoint-run': 'write',
	'access-control-default-rule-set-prepare': 'write',
	// a read token next to a write token
	'batch-export-get': 'write',
	'autoresearch-training-runs-artifacts-get-create': 'write',
	// named like a read, but PostHog does not mark it read-only (it starts a job)
	'workflows-data-suggestions-list': 'write',
}

describe('classifyPosthogInnerTool', () => {
	it('gives every sampled tool the expected verdict', () => {
		const wrong = Object.entries(SAMPLE)
			.filter(([name, expected]) => classifyPosthogInnerTool(name) !== expected)
			.map(([name]) => name)
		expect(wrong).toEqual([])
	})

	it('reads execute-sql because of the curated set, not the token rules', () => {
		// "execute" is a write word, so the token rules alone would refuse it.
		expect(classifyPosthogInnerTool('execute-sql')).toBe('read')
	})

	it('matches curated names exactly, never as a prefix', () => {
		for (const name of ['execute-sql-and-delete', 'execute-sql2', 'xexecute-sql', 'endpoint-run']) {
			expect(classifyPosthogInnerTool(name)).toBe('write')
		}
	})
})

describe('classifyPosthogCommand', () => {
	it('reads a query, schema or lookup call and names the inner tool, never the input', () => {
		expect(verdict('call query-trends {}')).toBe('read')
		expect(verdict('call execute-sql {"query":"SELECT 1; SELECT 2 && 3"}')).toBe('read')
		const read = classifyPosthogCommand('call query-trends {"email":"a@b.c"}')
		expect(read.innerTool).toBe('query-trends')
		expect(JSON.stringify(read)).not.toContain('a@b.c')
	})

	it('refuses create, update and delete tools and names them', () => {
		expect(classifyPosthogCommand('call dashboard-create {"name":"x"}')).toEqual({
			kind: 'write',
			innerTool: 'dashboard-create',
		})
		expect(verdict('call feature-flag-update {}')).toBe('write')
	})

	it('refuses --confirm and any other flag before the name, accepts --json', () => {
		expect(verdict('call --json query-trends {}')).toBe('read')
		expect(verdict('call   --json \t query-trends   {}  ')).toBe('read')
		expect(verdict('call --confirm query-trends {}')).toBe('write')
		expect(verdict('call --json --confirm query-trends {}')).toBe('write')
		expect(verdict('call --force query-trends {}')).toBe('write')
	})

	it('refuses anything after the tool name that is not exactly one JSON value', () => {
		for (const command of [
			'call query-trends {} ; call dashboard-create {}',
			'call query-trends {} && call dashboard-create {}',
			'call query-trends {} | call dashboard-create {}',
			'call query-trends ; call dashboard-create {}',
			'call query-trends {} {}',
			'call query-trends --json {}',
			'call query-trends --confirm',
			'call query-trends {"a":1',
		]) {
			expect(verdict(command)).toBe('write')
		}
		for (const command of [
			'call query-trends',
			'call query-trends [1,2]',
			'call query-trends "x"',
		]) {
			expect(verdict(command)).toBe('read')
		}
	})

	it('refuses a malformed tool name or case', () => {
		for (const command of [
			'call query/trends {}',
			'call "query-trends" {}',
			'call Query-Trends {}',
			'call query-trends{}',
			'call',
			'CALL query-trends {}',
			' call query-trends {}',
		]) {
			expect(verdict(command)).toBe('write')
		}
	})

	it('reads a discovery command with a plain tail and refuses anything else after it', () => {
		for (const command of ['help', 'tools', 'search feature-flags', 'schema events']) {
			expect(verdict(command)).toBe('read')
		}
		for (const command of [
			'help ; call dashboard-create {}',
			'search a && b',
			'info $(x)',
			'tools | cat',
			'help {}',
		]) {
			expect(verdict(command)).toBe('write')
		}
	})

	it('refuses an unknown first token, a non-string, control characters and a huge command', () => {
		for (const command of ['run query-trends', '', undefined, null, 1, {}, ['help']]) {
			expect(verdict(command)).toBe('write')
		}
		for (const command of [
			'help\nhelp',
			'call query-trends {}\r\ncall dashboard-create {}',
			'help\u0000',
			'help\u0085',
		]) {
			expect(verdict(command)).toBe('write')
		}
		expect(verdict(`call query-trends "${'x'.repeat(100_000)}"`)).toBe('write')
	})
})

describe('classifyCall', () => {
	const exec = { command: 'call query-trends {}' }

	it('judges the command only for provider posthog and the tool name exec', () => {
		expect(isCommandGated('posthog', 'exec')).toBe(true)
		expect(classifyCall('posthog', 'exec', exec).kind).toBe('read')
		expect(classifyCall('posthog', 'exec', { command: 'call dashboard-create {}' }).kind).toBe(
			'write',
		)
		expect(classifyCall('posthog', 'exec', undefined).kind).toBe('write')
	})

	it('gives every other name and provider the old name rules', () => {
		for (const [provider, name] of [
			['posthog', 'EXEC'],
			['posthog', 'exec '],
			['posthog', 'exec-sql'],
			['linear', 'exec'],
			['custom-mcp', 'exec'],
		]) {
			expect(isCommandGated(provider, name)).toBe(false)
			expect(classifyCall(provider, name, exec)).toEqual({ kind: classifyTool(provider, name) })
		}
	})

	it('does not let the server hint turn exec into a read', () => {
		const args = { command: 'call dashboard-create {}' }
		expect(classifyCall('posthog', 'exec', args, { readOnlyHint: true }).kind).toBe('write')
	})
})
