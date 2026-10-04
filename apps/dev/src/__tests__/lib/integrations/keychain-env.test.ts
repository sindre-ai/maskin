import { describe, expect, it } from 'vitest'
import {
	byoApiKeyEnvName,
	isRedactedEnvKey,
	redactLaunchEnv,
} from '../../../lib/integrations/keychain-env'

describe('byoApiKeyEnvName', () => {
	it.each([
		['Coolify', 'KEYCHAIN_BYO_APIKEY_COOLIFY'],
		['Notion team', 'KEYCHAIN_BYO_APIKEY_NOTION_TEAM'],
		['My-Key', 'KEYCHAIN_BYO_APIKEY_MY_KEY'],
	])('%s -> %s', (name, envName) => {
		expect(byoApiKeyEnvName(name)).toBe(envName)
	})

	it('is null when the name has nothing usable', () => {
		expect(byoApiKeyEnvName('🔑')).toBeNull()
		expect(byoApiKeyEnvName('   ')).toBeNull()
	})

	it('only ever produces a valid shell identifier', () => {
		const name = byoApiKeyEnvName('a; rm -rf / $(whoami) "quoted"') as string
		expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
	})
})

describe('redactLaunchEnv', () => {
	it.each(['KEYCHAIN_BYO_APIKEY_X', 'INTEGRATION_TOKEN_SLACK', 'BYO_ANYTHING'])(
		'treats %s as redacted',
		(key) => {
			expect(isRedactedEnvKey(key)).toBe(true)
		},
	)

	it('does not treat the existing token names or look-alikes as redacted by prefix', () => {
		expect(isRedactedEnvKey('GITHUB_TOKEN')).toBe(false)
		expect(isRedactedEnvKey('MY_KEYCHAIN_X')).toBe(false)
	})

	it('never carries a value, whatever the key', () => {
		const out = redactLaunchEnv({
			KEYCHAIN_BYO_APIKEY_COOLIFY: 'fake-secret-value-1',
			INTEGRATION_TOKEN_X: 'fake-secret-value-2',
			BYO_Y: 'fake-secret-value-3',
			MASKIN_API_KEY: 'fake-secret-value-4',
			MCP_SERVERS_JSON: '{"env":{"T":"fake-secret-value-5"}}',
		})
		expect(JSON.stringify(out)).not.toContain('fake-secret-value')
		expect(out.KEYCHAIN_BYO_APIKEY_COOLIFY).toBe('[redacted]')
		expect(out.INTEGRATION_TOKEN_X).toBe('[redacted]')
		expect(out.BYO_Y).toBe('[redacted]')
		expect(out.MASKIN_API_KEY).toBe('[set]')
	})
})
