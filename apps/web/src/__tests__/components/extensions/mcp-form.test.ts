import {
	buildMcpConfig,
	capMessage,
	emptyMcpForm,
	formFromMcpConfig,
	mcpReady,
	rowsFromDeclared,
	rowsFromProbe,
	selectedTools,
	validateMcpForm,
} from '@/components/extensions/mcp-form'
import { describe, expect, it } from 'vitest'

const tool = (name: string) => ({ name, kind: 'read' as const })

describe('rowsFromProbe', () => {
	it('ticks every tool when the server lists 20 or fewer', () => {
		const rows = rowsFromProbe(Array.from({ length: 20 }, (_, i) => tool(`get_${i}`)))
		expect(rows.every((r) => r.selected)).toBe(true)
	})

	it('pre-ticks the first 20 alphabetically when the server lists 21 or more', () => {
		const names = Array.from({ length: 25 }, (_, i) => `tool_${String(i).padStart(2, '0')}`)
		const rows = rowsFromProbe([...names].reverse().map(tool))
		expect(rows.map((r) => r.name)).toEqual(names)
		expect(rows.filter((r) => r.selected)).toHaveLength(20)
		expect(rows[19]?.selected).toBe(true)
		expect(rows[20]?.selected).toBe(false)
	})
})

describe('capMessage', () => {
	it('is silent at exactly 20 and names the count above it', () => {
		expect(capMessage(20)).toBeNull()
		expect(capMessage(21)).toContain('21 tools')
		expect(capMessage(21)).toContain('Cap is 20')
	})
})

describe('rowsFromDeclared', () => {
	it('splits by line or comma, dedupes, defaults the kind from the name, and flags bad names', () => {
		const { rows, invalid } = rowsFromDeclared(
			'get_transcript, bookmark_meeting\nget_transcript\nbad name!',
		)
		expect(rows.map((r) => [r.name, r.kind])).toEqual([
			['get_transcript', 'read'],
			['bookmark_meeting', 'write'],
		])
		expect(invalid).toEqual(['bad name!'])
	})
})

describe('selectedTools', () => {
	it('keeps only ticked tools and drops the selected flag', () => {
		const rows = rowsFromProbe([tool('a'), tool('b')]).map((r) => ({
			...r,
			selected: r.name === 'b',
		}))
		expect(selectedTools(rows)).toEqual([{ name: 'b', kind: 'read' }])
	})
})

describe('validateMcpForm', () => {
	it('needs an https URL and, for a new MCP with a key, the key', () => {
		expect(validateMcpForm(emptyMcpForm('http://x.example/mcp'), { editing: false })).toMatchObject(
			{
				serverUrl: expect.any(String),
				apiKey: expect.any(String),
			},
		)
		expect(
			validateMcpForm(
				{ ...emptyMcpForm('https://x.example/mcp'), apiKey: 'k' },
				{ editing: false },
			),
		).toEqual({})
	})

	it('needs no key when auth is none, or when editing and keeping the stored key', () => {
		const url = 'https://x.example/mcp'
		expect(validateMcpForm({ ...emptyMcpForm(url), auth: 'none' }, { editing: false })).toEqual({})
		expect(validateMcpForm({ ...emptyMcpForm(url), replaceKey: false }, { editing: true })).toEqual(
			{},
		)
	})
})

describe('buildMcpConfig and formFromMcpConfig', () => {
	it('wraps the URL as npx mcp-remote with the key in the Authorization header env', () => {
		const cfg = buildMcpConfig({
			slug: 'fireflies',
			serverUrl: ' https://api.fireflies.ai/mcp ',
			auth: 'api-key',
			tools: [tool('get_transcript')],
		})
		expect(cfg.server).toEqual({
			type: 'stdio',
			command: 'npx',
			args: [
				'mcp-remote',
				'https://api.fireflies.ai/mcp',
				'--header',
				'Authorization:${AUTHORIZATION}',
			],
			envFromCredential: 'AUTHORIZATION',
		})
		expect(cfg.credentialProvider).toBe('extension-mcp:fireflies')
		expect(cfg.autoInject).toBe(true)
	})

	it('leaves the key out entirely when auth is none', () => {
		const cfg = buildMcpConfig({
			slug: 'x',
			serverUrl: 'https://x.example/mcp',
			auth: 'none',
			tools: [],
		})
		expect(cfg.server).toEqual({
			type: 'stdio',
			command: 'npx',
			args: ['mcp-remote', 'https://x.example/mcp'],
		})
	})

	it('reads the saved config back into a form that keeps the stored key', () => {
		const mcpConfig = buildMcpConfig({
			slug: 'x',
			serverUrl: 'https://x.example/mcp',
			auth: 'api-key',
			tools: [],
		})
		expect(formFromMcpConfig({ mcpConfig, hasMcpKey: true })).toEqual({
			serverUrl: 'https://x.example/mcp',
			auth: 'api-key',
			apiKey: '',
			replaceKey: false,
		})
	})
})

describe('mcpReady', () => {
	const mcpConfig = buildMcpConfig({
		slug: 'x',
		serverUrl: 'https://x.example/mcp',
		auth: 'api-key',
		tools: [],
	})

	it('needs a config, a stored key when auth uses one, and no runtime error', () => {
		expect(mcpReady({ mcpConfig: null, hasMcpKey: false, mcpLastError: null })).toBe(false)
		expect(mcpReady({ mcpConfig, hasMcpKey: false, mcpLastError: null })).toBe(false)
		expect(mcpReady({ mcpConfig, hasMcpKey: true, mcpLastError: 'tool cap exceeded: 21/20' })).toBe(
			false,
		)
		expect(mcpReady({ mcpConfig, hasMcpKey: true, mcpLastError: null })).toBe(true)
	})
})
