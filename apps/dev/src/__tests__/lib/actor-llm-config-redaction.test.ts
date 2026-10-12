import { describe, expect, it } from 'vitest'
import {
	hasLlmApiKey,
	maskActorLlmConfig,
	restoreMaskedLlmApiKey,
} from '../../lib/actor-llm-config-redaction'
import { MASKED_VALUE } from '../../lib/actor-tools-redaction'

// Obviously fake value only.
const FAKE_KEY = 'fake-llm-key-not-a-secret'
const stored = { api_key: FAKE_KEY, model: 'fake-model' }
const sameProvider = { incoming: undefined, stored: 'anthropic' }

describe('maskActorLlmConfig', () => {
	it('masks api_key and keeps model visible', () => {
		expect(maskActorLlmConfig(stored)).toEqual({ api_key: MASKED_VALUE, model: 'fake-model' })
	})

	it('returns configs without an api_key unchanged', () => {
		const noKey = { model: 'fake-model', api_key: '' }
		expect(maskActorLlmConfig(noKey)).toBe(noKey)
		expect(maskActorLlmConfig(null)).toBeNull()
		expect(hasLlmApiKey({ model: 'fake-model' })).toBe(false)
	})
})

describe('restoreMaskedLlmApiKey', () => {
	it('puts the stored key back and keeps an edited model', () => {
		const incoming = { api_key: MASKED_VALUE, model: 'other-model' }

		expect(restoreMaskedLlmApiKey(incoming, stored, sameProvider)).toEqual({
			llmConfig: { api_key: FAKE_KEY, model: 'other-model' },
			unresolved: false,
		})
	})

	it('leaves a real new key alone', () => {
		const incoming = { api_key: 'fake-rotated', model: 'fake-model' }

		expect(restoreMaskedLlmApiKey(incoming, stored, sameProvider)).toEqual({
			llmConfig: incoming,
			unresolved: false,
		})
	})

	it('rejects a mask when the provider changes', () => {
		const incoming = { api_key: MASKED_VALUE }

		const result = restoreMaskedLlmApiKey(incoming, stored, {
			incoming: 'openai',
			stored: 'anthropic',
		})

		expect(result.unresolved).toBe(true)
		expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
	})

	it('rejects a mask when another key such as a base url differs from the stored one', () => {
		const storedWithUrl = { ...stored, base_url: 'https://llm.example.test' }
		const incoming = { api_key: MASKED_VALUE, base_url: 'https://attacker.example.test' }

		expect(restoreMaskedLlmApiKey(incoming, storedWithUrl, sameProvider).unresolved).toBe(true)
	})

	it('rejects a mask when nothing is stored', () => {
		expect(restoreMaskedLlmApiKey({ api_key: MASKED_VALUE }, null, sameProvider).unresolved).toBe(
			true,
		)
		expect(
			restoreMaskedLlmApiKey({ api_key: MASKED_VALUE }, { model: 'fake-model' }, sameProvider)
				.unresolved,
		).toBe(true)
	})
})
