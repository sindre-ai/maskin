import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	llmConfigured,
	llmKeyHints,
	redactWorkspaceSettings,
	workspaceForCaller,
} from '../../lib/workspace-redaction'
import { sealSecret } from '../../lib/workspace-secrets'

beforeEach(() => {
	vi.stubEnv('INTEGRATION_ENCRYPTION_KEY', '1234567890abcdef'.repeat(4))
})

// Obviously fake values only.
const settings = () => ({
	pinned_files: ['f1'],
	llm_keys: { anthropic: 'fake-anthropic-key-1234', openai: null },
	custom_llm: { enabled: true, api_key: 'fake-custom-key-5678', model: 'm' },
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
		expect(input.llm_keys.anthropic).toBe('fake-anthropic-key-1234')
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

describe('llmKeyHints', () => {
	it('is the last four characters of each stored key, null where there is none', () => {
		expect(llmKeyHints(settings())).toEqual({ anthropic: '1234', openai: null, custom_llm: '5678' })
	})

	it('reads a sealed key through to its last four characters', () => {
		const sealed = { llm_keys: { anthropic: sealSecret('fake-anthropic-key-9999') } }
		expect(llmKeyHints(sealed).anthropic).toBe('9999')
	})

	it('is null for a key under 12 characters, an unreadable one, or no settings', () => {
		const none = { anthropic: null, openai: null, custom_llm: null }
		expect(llmKeyHints({ llm_keys: { anthropic: 'short-key' } })).toEqual(none)
		expect(llmKeyHints({ llm_keys: { anthropic: 'enc:v1:not:valid:data' } })).toEqual(none)
		expect(llmKeyHints(null)).toEqual(none)
	})
})

describe('workspaceForCaller', () => {
	it('gives a human admin or owner settings without any key, plus llm_configured and hints', () => {
		const out = workspaceForCaller({ id: 'w', settings: settings() }, true)
		expect(out.settings).toEqual({
			pinned_files: ['f1'],
			custom_llm: { enabled: true, model: 'm' },
			claude_oauth: { primary: { access_token: 'fake-oauth-token' } },
			billing: { plan: 'team', stripe_customer_id: 'cus_fake' },
		})
		expect(JSON.stringify(out)).not.toContain('fake-anthropic-key')
		expect(JSON.stringify(out)).not.toContain('fake-custom-key')
		expect(out.llm_configured.anthropic).toBe(true)
		expect(out).toMatchObject({ llm_key_hints: { anthropic: '1234', custom_llm: '5678' } })
	})

	it('gives everyone else no hints', () => {
		const out = workspaceForCaller({ id: 'w', settings: settings() }, false)
		expect('llm_key_hints' in out).toBe(false)
	})

	it('gives everyone else settings without the admin-only keys, and llm_configured', () => {
		const out = workspaceForCaller({ id: 'w', settings: settings() }, false)
		expect(out.settings).toEqual({ pinned_files: ['f1'] })
		expect(out.llm_configured).toEqual({ anthropic: true, openai: false, custom_llm: true })
		expect('llm_configured' in out.settings).toBe(false)
	})
})
