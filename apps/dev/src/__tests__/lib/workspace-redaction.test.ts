import { describe, expect, it } from 'vitest'
import {
	llmConfigured,
	redactWorkspaceSettings,
	workspaceForCaller,
} from '../../lib/workspace-redaction'

// Obviously fake values only.
const settings = () => ({
	pinned_files: ['f1'],
	llm_keys: { anthropic: 'fake-anthropic-key', openai: null },
	custom_llm: { enabled: true, api_key: 'fake-custom-key', model: 'm' },
	claude_oauth: { primary: { access_token: 'fake-oauth-token' } },
	billing: { plan: 'team', stripe_customer_id: 'cus_fake' },
})

describe('redactWorkspaceSettings', () => {
	it('drops llm_keys, custom_llm, claude_oauth and billing and keeps every other key', () => {
		expect(redactWorkspaceSettings(settings())).toEqual({ pinned_files: ['f1'] })
	})

	it('does not mutate its input', () => {
		const input = settings()
		redactWorkspaceSettings(input)
		expect(input.llm_keys.anthropic).toBe('fake-anthropic-key')
	})

	it('returns an empty object for missing or non-object settings', () => {
		expect(redactWorkspaceSettings(null)).toEqual({})
		expect(redactWorkspaceSettings(undefined)).toEqual({})
	})
})

describe('llmConfigured', () => {
	it('is true for a stored key and false otherwise', () => {
		expect(llmConfigured(settings())).toEqual({ anthropic: true, openai: false, custom_llm: true })
	})

	it('is all false when nothing is stored or an api_key is empty or null', () => {
		const none = { anthropic: false, openai: false, custom_llm: false }
		expect(llmConfigured({})).toEqual(none)
		expect(llmConfigured(null)).toEqual(none)
		expect(llmConfigured({ llm_keys: { anthropic: '' }, custom_llm: { api_key: null } })).toEqual(
			none,
		)
	})
})

describe('workspaceForCaller', () => {
	it('gives a human admin or owner the stored settings plus llm_configured', () => {
		const out = workspaceForCaller({ id: 'w', settings: settings() }, true)
		expect(out.settings).toEqual(settings())
		expect(out.llm_configured.anthropic).toBe(true)
	})

	it('gives everyone else settings without the admin-only keys, and llm_configured', () => {
		const out = workspaceForCaller({ id: 'w', settings: settings() }, false)
		expect(out.settings).toEqual({ pinned_files: ['f1'] })
		expect(out.llm_configured).toEqual({ anthropic: true, openai: false, custom_llm: true })
		expect('llm_configured' in out.settings).toBe(false)
	})
})
