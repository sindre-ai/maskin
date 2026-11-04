import { describe, expect, it } from 'vitest'
import {
	findUnresolvedKeychainReferences,
	keychainReferences,
	stripSessionLevelMcps,
} from '../../../lib/integrations/keychain-mcp-guard'

const stdio = { type: 'stdio', command: 'sh', args: ['-c', 'env'] }
const plainHttp = { type: 'http', url: 'https://example.com/mcp', headers: { 'X-A': 'b' } }
const maskinHttp = {
	type: 'http',
	url: '${MASKIN_API_URL}/mcp',
	headers: { Authorization: 'Bearer ${MASKIN_API_KEY}' },
}

describe('keychainReferences', () => {
	it('finds both envsubst forms anywhere in an entry, names only', () => {
		const entry = {
			type: 'http',
			url: 'https://x.test/mcp?key=${KEYCHAIN_BYO_APIKEY_A}',
			headers: { Authorization: 'Bearer $KEYCHAIN_BYO_APIKEY_B' },
		}
		expect(keychainReferences(entry).sort()).toEqual([
			'KEYCHAIN_BYO_APIKEY_A',
			'KEYCHAIN_BYO_APIKEY_B',
		])
	})

	it('ignores other variables', () => {
		expect(keychainReferences(maskinHttp)).toEqual([])
	})
})

describe('stripSessionLevelMcps', () => {
	it('drops every stdio entry, keeping the original index in the name', () => {
		const { kept, dropped } = stripSessionLevelMcps([plainHttp, stdio, maskinHttp])
		expect(Object.keys(kept)).toEqual(['session-mcp-0', 'session-mcp-2'])
		expect(dropped).toEqual([
			{ name: 'session-mcp-1', reason: 'stdio_command_in_keychain_session' },
		])
	})

	it('drops a stdio entry that also carries a url, as the schema reads it as stdio', () => {
		const remote = { command: 'npx', args: ['mcp-remote'], url: 'https://x.test' }
		expect(stripSessionLevelMcps([remote]).dropped).toHaveLength(1)
	})

	it('drops an http entry that names a Keychain key, in a header or a url query', () => {
		const inHeader = { ...plainHttp, headers: { Authorization: 'Bearer ${KEYCHAIN_BYO_APIKEY_A}' } }
		const inUrl = { type: 'http', url: 'https://x.test/mcp?k=${KEYCHAIN_BYO_APIKEY_A}' }
		const { kept, dropped } = stripSessionLevelMcps([inHeader, inUrl])
		expect(kept).toEqual({})
		expect(dropped.map((d) => d.reason)).toEqual([
			'http_names_keychain_key',
			'http_names_keychain_key',
		])
	})

	it('keeps an http entry that names no Keychain key', () => {
		const { kept, dropped } = stripSessionLevelMcps([plainHttp, maskinHttp])
		expect(kept).toEqual({ 'session-mcp-0': plainHttp, 'session-mcp-1': maskinHttp })
		expect(dropped).toEqual([])
	})

	it('never puts a value in what it reports', () => {
		const withValue = { type: 'stdio', command: 'sh', env: { K: 'literal-secret-value' } }
		const { dropped } = stripSessionLevelMcps([withValue])
		expect(JSON.stringify(dropped)).not.toContain('literal-secret-value')
	})
})

describe('findUnresolvedKeychainReferences', () => {
	const servers = {
		coolify: {
			type: 'http',
			url: 'https://x.test',
			headers: { A: 'Bearer ${KEYCHAIN_BYO_APIKEY_C}' },
		},
		other: plainHttp,
	}

	it('reports a reference the env does not hold, once per server and name', () => {
		expect(findUnresolvedKeychainReferences(servers, {})).toEqual([
			{ server: 'coolify', envName: 'KEYCHAIN_BYO_APIKEY_C' },
		])
	})

	it('reports an empty value as unresolved', () => {
		expect(findUnresolvedKeychainReferences(servers, { KEYCHAIN_BYO_APIKEY_C: '' })).toHaveLength(1)
	})

	it('reports nothing when the env holds the name', () => {
		expect(findUnresolvedKeychainReferences(servers, { KEYCHAIN_BYO_APIKEY_C: 'v' })).toEqual([])
	})
})
