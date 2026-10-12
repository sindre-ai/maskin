import { describe, expect, it } from 'vitest'
import {
	CREDENTIAL_NAME_MAX_LENGTH,
	KEYCHAIN_BYO_APIKEY_ENV_PREFIX,
	byoApiKeyEnvVar,
	checkCredentialName,
	credentialNameMessage,
	manualRedactionMarker,
} from '../credential-name'
import { redactionMarker, scanForSecrets } from '../secret-scanner'

// Every prefix the detection table keys on. Names are built from these at runtime so
// no token-shaped literal sits in the repo.
const PREFIXES = [
	'cfut_',
	'cfat_',
	'cfk_',
	'ghp_',
	'github_pat_',
	'sk_live_',
	'sk_test_',
	'xoxb-',
	'xoxp-',
	'sk-',
	'sk-proj-',
	'sk-svcacct-',
]

describe('checkCredentialName', () => {
	it.each([
		['Coolify', null],
		['Notion team', null],
		['  padded  ', null],
		['', 'empty'],
		['   ', 'empty'],
		['x'.repeat(CREDENTIAL_NAME_MAX_LENGTH), null],
		['x'.repeat(CREDENTIAL_NAME_MAX_LENGTH + 1), 'too_long'],
		['bad [name]', 'bad_characters'],
		['bad ] name', 'bad_characters'],
		['tab\there', 'bad_characters'],
		['line\nbreak', 'bad_characters'],
		['nul\u0000byte', 'bad_characters'],
		['🔑🔑', 'no_slug'],
		['---', 'no_slug'],
	])('%j -> %s', (name, problem) => {
		expect(checkCredentialName(name)).toBe(problem)
	})

	it('rejects a name shaped like each provider secret', () => {
		const secrets = [
			`cfut_${'A1'.repeat(20)}`,
			`ghp_${'a'.repeat(36)}`,
			`sk_live_${'c'.repeat(24)}`,
			`xoxb-${'1'.repeat(24)}`,
			`sk-${'e'.repeat(48)}`.slice(0, 50),
		]
		for (const secret of secrets) {
			expect(checkCredentialName(secret)).toBe('looks_like_secret')
		}
	})

	it('gives every problem a message', () => {
		for (const problem of [
			'empty',
			'too_long',
			'bad_characters',
			'no_slug',
			'looks_like_secret',
		] as const) {
			expect(credentialNameMessage(problem).length).toBeGreaterThan(0)
		}
	})
})

describe('byoApiKeyEnvVar', () => {
	it('is the prefix plus the slug', () => {
		expect(byoApiKeyEnvVar('Coolify')).toBe(`${KEYCHAIN_BYO_APIKEY_ENV_PREFIX}COOLIFY`)
		expect(byoApiKeyEnvVar('Notion team')).toBe(`${KEYCHAIN_BYO_APIKEY_ENV_PREFIX}NOTION_TEAM`)
	})

	it('is null when nothing usable is left', () => {
		expect(byoApiKeyEnvVar('🔑')).toBeNull()
	})
})

describe('manualRedactionMarker', () => {
	it('names the credential and its env var, with no provider prefix', () => {
		expect(manualRedactionMarker('Coolify')).toBe(
			'[REDACTED · vaulted as Coolify · env KEYCHAIN_BYO_APIKEY_COOLIFY]',
		)
	})

	it('never matches the detection table, for names built from every provider prefix', () => {
		for (const prefix of PREFIXES) {
			// From the bare prefix up to the cap, one character at a time: every name that
			// the rule lets through must give a marker the server backstop will accept, and
			// every one it blocks must be blocked for looking like a secret (or for length).
			for (let n = 0; n <= CREDENTIAL_NAME_MAX_LENGTH - prefix.length; n++) {
				const name = `${prefix}${'a'.repeat(n)}`
				const problem = checkCredentialName(name)
				if (problem === null) {
					expect(scanForSecrets(manualRedactionMarker(name), { highOnly: true })).toEqual([])
					expect(scanForSecrets(redactionMarker(`${prefix}x`, name), { highOnly: true })).toEqual(
						[],
					)
				} else {
					expect(problem).toBe('looks_like_secret')
				}
			}
		}
	})

	it('survives adversarial names', () => {
		for (const name of ['sk-', 'sk-proj-', 'ghp_', 'cfut_', 'sk_live_', 'xoxb-', 'github_pat_']) {
			expect(checkCredentialName(name)).toBeNull()
			expect(scanForSecrets(manualRedactionMarker(name), { highOnly: true })).toEqual([])
		}
	})
})
