import { describe, expect, it } from 'vitest'
import { maskLlmConfigSecrets, restoreMaskedLlmConfig } from '../../lib/actor-llm-config-redaction'
import { MASKED_VALUE } from '../../lib/actor-tools-redaction'

// Obviously fake values only.
const FAKE_KEY = 'not-a-real-key'
const FAKE_OTHER_KEY = 'not-a-real-key-either'

describe('maskLlmConfigSecrets', () => {
	it('masks api_key and keeps the other keys', () => {
		expect(maskLlmConfigSecrets({ api_key: FAKE_KEY, model: 'some-model' })).toEqual({
			api_key: MASKED_VALUE,
			model: 'some-model',
		})
	})

	it('masks apiKey, and either spelling in any letter case', () => {
		expect(
			maskLlmConfigSecrets({ apiKey: FAKE_KEY, API_KEY: FAKE_KEY, ApiKey: FAKE_KEY, model: 'm' }),
		).toEqual({ apiKey: MASKED_VALUE, API_KEY: MASKED_VALUE, ApiKey: MASKED_VALUE, model: 'm' })
	})

	it('masks at any depth, including inside arrays', () => {
		const masked = maskLlmConfigSecrets({
			model: 'm',
			fallback: { apiKey: FAKE_KEY, nested: [{ api_key: FAKE_OTHER_KEY, name: 'second' }] },
		})

		expect(masked).toEqual({
			model: 'm',
			fallback: { apiKey: MASKED_VALUE, nested: [{ api_key: MASKED_VALUE, name: 'second' }] },
		})
		expect(JSON.stringify(masked)).not.toContain('not-a-real-key')
	})

	it('keeps presence visible: an empty key is masked, an absent or null key stays as it is', () => {
		expect(maskLlmConfigSecrets({ api_key: '' })).toEqual({ api_key: MASKED_VALUE })
		expect(maskLlmConfigSecrets({ api_key: null })).toEqual({ api_key: null })
		expect(maskLlmConfigSecrets({ model: 'm' })).toEqual({ model: 'm' })
	})

	it('does not mask keys that merely contain the name', () => {
		const config = { model: 'm', api_key_hint: 'last four: 1234', token_budget_month: 1000 }
		expect(maskLlmConfigSecrets(config)).toEqual(config)
	})

	it('passes null, undefined and scalars through', () => {
		expect(maskLlmConfigSecrets(null)).toBeNull()
		expect(maskLlmConfigSecrets(undefined)).toBeUndefined()
		expect(maskLlmConfigSecrets('text')).toBe('text')
	})

	it('does not mutate its input', () => {
		const input = { api_key: FAKE_KEY, nested: { apiKey: FAKE_OTHER_KEY } }
		const snapshot = structuredClone(input)

		maskLlmConfigSecrets(input)

		expect(input).toEqual(snapshot)
	})
})

describe('restoreMaskedLlmConfig', () => {
	it('replaces a masked api_key with the stored value', () => {
		const result = restoreMaskedLlmConfig(
			{ api_key: MASKED_VALUE, model: 'new-model' },
			{ api_key: FAKE_KEY, model: 'old-model' },
		)

		expect(result.unresolved).toEqual([])
		expect(result.llmConfig).toEqual({ api_key: FAKE_KEY, model: 'new-model' })
	})

	it('restores apiKey nested at depth from the same path', () => {
		const result = restoreMaskedLlmConfig(
			{ fallback: { apiKey: MASKED_VALUE } },
			{ fallback: { apiKey: FAKE_KEY } },
		)

		expect(result.unresolved).toEqual([])
		expect(result.llmConfig).toEqual({ fallback: { apiKey: FAKE_KEY } })
	})

	it('keeps a real new value instead of the stored one', () => {
		const result = restoreMaskedLlmConfig({ api_key: FAKE_OTHER_KEY }, { api_key: FAKE_KEY })

		expect(result.unresolved).toEqual([])
		expect(result.llmConfig).toEqual({ api_key: FAKE_OTHER_KEY })
	})

	it('reports a mask with nothing stored as unresolved, naming the path and never a value', () => {
		const result = restoreMaskedLlmConfig({ api_key: MASKED_VALUE }, null)

		expect(result.unresolved).toEqual(['llm_config.api_key'])
		expect(JSON.stringify(result)).not.toContain(FAKE_KEY)
	})

	it('reports a mask whose stored value is missing at that path', () => {
		const result = restoreMaskedLlmConfig(
			{ api_key: MASKED_VALUE, fallback: { apiKey: MASKED_VALUE } },
			{ api_key: FAKE_KEY },
		)

		expect(result.unresolved).toEqual(['llm_config.fallback.apiKey'])
	})

	it('does not restore across spellings', () => {
		const result = restoreMaskedLlmConfig({ api_key: MASKED_VALUE }, { apiKey: FAKE_KEY })

		expect(result.unresolved).toEqual(['llm_config.api_key'])
	})

	it('leaves a config without masks untouched', () => {
		const result = restoreMaskedLlmConfig({ model: 'm' }, { api_key: FAKE_KEY })

		expect(result).toEqual({ llmConfig: { model: 'm' }, unresolved: [] })
	})

	it('does not mutate its inputs', () => {
		const incoming = { api_key: MASKED_VALUE }
		const stored = { api_key: FAKE_KEY }

		restoreMaskedLlmConfig(incoming, stored)

		expect(incoming).toEqual({ api_key: MASKED_VALUE })
		expect(stored).toEqual({ api_key: FAKE_KEY })
	})

	it('round-trips: masking then restoring gives back the stored config', () => {
		const stored = { api_key: FAKE_KEY, model: 'm', fallback: { apiKey: FAKE_OTHER_KEY } }

		const result = restoreMaskedLlmConfig(maskLlmConfigSecrets(stored), stored)

		expect(result.unresolved).toEqual([])
		expect(result.llmConfig).toEqual(stored)
	})
})
