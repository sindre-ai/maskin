import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { logger } from '../../lib/logger'
import {
	SEALED_PREFIX,
	SecretUnreadableError,
	countWorkspaceLlmSecrets,
	isSealed,
	openSecret,
	openWorkspaceLlmSecrets,
	rewriteWorkspaceLlmSecrets,
	sealSecret,
	sealWorkspaceLlmSecrets,
} from '../../lib/workspace-secrets'

// Obviously fake placeholders, never real credentials.
const KEY_A = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
const KEY_B = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'

beforeEach(() => {
	vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', KEY_A)
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.clearAllMocks()
})

const plainSettings = () => ({
	max_concurrent_sessions: 3,
	llm_keys: { anthropic: 'FAKE-anthropic', openai: 'FAKE-openai', stale: null },
	custom_llm: { enabled: true, base_url: 'https://llm.test', api_key: 'FAKE-custom', model: 'm' },
})

describe('sealSecret / openSecret', () => {
	it('round trips and prefixes the stored text', () => {
		const sealed = sealSecret('FAKE-value')
		expect(sealed.startsWith(SEALED_PREFIX)).toBe(true)
		expect(isSealed(sealed)).toBe(true)
		expect(sealed).not.toContain('FAKE-value')
		expect(openSecret(sealed)).toBe('FAKE-value')
	})

	it('seals the same value to different text each time', () => {
		expect(sealSecret('FAKE-value')).not.toBe(sealSecret('FAKE-value'))
	})

	it('returns a value without the prefix as is, and does not need the encryption key for it', () => {
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '')
		expect(openSecret('FAKE-legacy-plain')).toBe('FAKE-legacy-plain')
	})

	it('throws SecretUnreadableError naming the field, never the value, when the key changed', () => {
		const sealed = sealSecret('FAKE-value')
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', KEY_B)
		const err = (() => {
			try {
				openSecret(sealed, 'llm_keys.anthropic')
			} catch (e) {
				return e
			}
		})()
		expect(err).toBeInstanceOf(SecretUnreadableError)
		expect((err as SecretUnreadableError).field).toBe('llm_keys.anthropic')
		expect((err as Error).message).not.toContain('FAKE-value')
		expect((err as Error).message).not.toContain(sealed)
	})

	it('throws SecretUnreadableError when the encryption key is missing', () => {
		const sealed = sealSecret('FAKE-value')
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '')
		expect(() => openSecret(sealed)).toThrow(SecretUnreadableError)
	})

	it('refuses to seal when the encryption key is missing, instead of storing plain text', () => {
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '')
		expect(() => sealSecret('FAKE-value')).toThrow('INTEGRATION_ENCRYPTION_KEY')
	})
})

describe('sealWorkspaceLlmSecrets / openWorkspaceLlmSecrets', () => {
	it('seals every llm_keys value and custom_llm.api_key, and nothing else', () => {
		const input = plainSettings()
		const sealed = sealWorkspaceLlmSecrets(input)

		expect(isSealed(sealed.llm_keys.anthropic as string)).toBe(true)
		expect(isSealed(sealed.llm_keys.openai as string)).toBe(true)
		expect(sealed.llm_keys.stale).toBeNull()
		expect(isSealed(sealed.custom_llm.api_key)).toBe(true)
		expect(sealed.custom_llm).toMatchObject({
			enabled: true,
			base_url: 'https://llm.test',
			model: 'm',
		})
		expect(sealed.max_concurrent_sessions).toBe(3)
		// The input is not modified.
		expect(input).toEqual(plainSettings())
	})

	it('leaves null, empty and absent secrets alone', () => {
		const sealed = sealWorkspaceLlmSecrets({
			llm_keys: { anthropic: null, openai: '' },
			custom_llm: { enabled: false, api_key: null },
		})
		expect(sealed).toEqual({
			llm_keys: { anthropic: null, openai: '' },
			custom_llm: { enabled: false, api_key: null },
		})
		expect(sealWorkspaceLlmSecrets({ max_concurrent_sessions: 1 })).toEqual({
			max_concurrent_sessions: 1,
		})
		expect(sealWorkspaceLlmSecrets(undefined)).toBeUndefined()
	})

	it('opens what it sealed', () => {
		const opened = openWorkspaceLlmSecrets(sealWorkspaceLlmSecrets(plainSettings()))
		expect(opened).toEqual(plainSettings())
	})

	it('opens a mix of sealed and legacy plain values', () => {
		const mixed = {
			llm_keys: { anthropic: sealSecret('FAKE-anthropic'), openai: 'FAKE-legacy-openai' },
		}
		expect(openWorkspaceLlmSecrets(mixed)).toEqual({
			llm_keys: { anthropic: 'FAKE-anthropic', openai: 'FAKE-legacy-openai' },
		})
	})

	it('throws on a value it cannot open, unless told to leave it out', () => {
		const sealed = sealWorkspaceLlmSecrets(plainSettings())
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', KEY_B)

		expect(() => openWorkspaceLlmSecrets(sealed)).toThrow(SecretUnreadableError)

		const lenient = openWorkspaceLlmSecrets(sealed, { omitUnreadable: true })
		expect(lenient.llm_keys.anthropic).toBeUndefined()
		expect(lenient.custom_llm.api_key).toBeUndefined()
		expect(lenient.custom_llm.model).toBe('m')
		expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { field: 'llm_keys.anthropic' })
		expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('FAKE-anthropic')
	})

	it('does not touch the encryption key when nothing in settings is sealed', () => {
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '')
		expect(openWorkspaceLlmSecrets(plainSettings())).toEqual(plainSettings())
		expect(openWorkspaceLlmSecrets({})).toEqual({})
	})
})

describe('countWorkspaceLlmSecrets / rewriteWorkspaceLlmSecrets', () => {
	it('counts sealed and plain values without needing the key', () => {
		const settings = plainSettings()
		settings.llm_keys.openai = sealSecret('FAKE-openai')
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '')
		expect(countWorkspaceLlmSecrets(settings)).toEqual({ sealed: 1, plain: 2 })
		expect(countWorkspaceLlmSecrets({})).toEqual({ sealed: 0, plain: 0 })
	})

	it('seals the plain values only, and a second run changes nothing', () => {
		const settings = plainSettings()
		settings.llm_keys.openai = sealSecret('FAKE-openai')
		const alreadySealed = settings.llm_keys.openai

		const first = rewriteWorkspaceLlmSecrets(settings, 'seal')
		expect(first.rewritten).toBe(2)
		expect(first.settings.llm_keys.openai).toBe(alreadySealed)
		expect(countWorkspaceLlmSecrets(first.settings)).toEqual({ sealed: 3, plain: 0 })

		const second = rewriteWorkspaceLlmSecrets(first.settings, 'seal')
		expect(second.rewritten).toBe(0)
		expect(second.settings).toEqual(first.settings)
	})

	it('opens the sealed values back to plain text in open mode', () => {
		const sealed = rewriteWorkspaceLlmSecrets(plainSettings(), 'seal').settings
		const back = rewriteWorkspaceLlmSecrets(sealed, 'open')
		expect(back.rewritten).toBe(3)
		expect(back.settings).toEqual(plainSettings())
		expect(rewriteWorkspaceLlmSecrets(back.settings, 'open').rewritten).toBe(0)
	})

	it('fails open mode on a value it cannot read', () => {
		const sealed = rewriteWorkspaceLlmSecrets(plainSettings(), 'seal').settings
		vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', KEY_B)
		expect(() => rewriteWorkspaceLlmSecrets(sealed, 'open')).toThrow(SecretUnreadableError)
	})
})
