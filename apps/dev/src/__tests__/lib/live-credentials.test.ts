import { describe, expect, it } from 'vitest'
import { isOpenRouterModelId, resolveLiveCredentials } from '../../lib/live-credentials'
import type { WorkspaceSettings } from '../../lib/types'

const ws = { enterpriseGranted: false, billingOwnerId: null }
const agent = { llmConfig: null, metadata: null }
const env = {
	MASKIN_FALLBACK_OPENROUTER_KEY: 'op-key',
	MASKIN_FALLBACK_MODEL: 'deepseek/deepseek-v4.1-flash',
}
const settings = (s: Record<string, unknown> = {}) => s as unknown as WorkspaceSettings

describe('resolveLiveCredentials', () => {
	it('prefers the workspace OpenRouter key', () => {
		const r = resolveLiveCredentials({
			wsSettings: settings({ llm_keys: { openrouter: 'ws-key' } }),
			workspace: ws,
			agent,
			env,
		})
		expect(r?.route).toBe('workspace_openrouter_key')
		expect(r?.apiKey).toBe('ws-key')
		expect(r?.providerPrefs).toBeUndefined()
	})

	it('accepts custom_llm only when it points at OpenRouter', () => {
		const on = resolveLiveCredentials({
			wsSettings: settings({
				custom_llm: { enabled: true, api_key: 'k', base_url: 'https://openrouter.ai/api' },
			}),
			workspace: ws,
			agent,
			env: {},
		})
		expect(on?.route).toBe('workspace_custom_llm')
		const off = resolveLiveCredentials({
			wsSettings: settings({
				custom_llm: { enabled: true, api_key: 'k', base_url: 'http://localhost:11434' },
			}),
			workspace: ws,
			agent,
			env: {},
		})
		expect(off).toBeNull()
	})

	it('falls back to the operator key on Maskin-funded plans with zdr preferences', () => {
		const r = resolveLiveCredentials({
			wsSettings: settings({ billing: { plan: 'pro' } }),
			workspace: ws,
			agent,
			env: { ...env, MASKIN_FALLBACK_ZDR: 'true' },
		})
		expect(r?.route).toBe('maskin_plan')
		expect(r?.apiKey).toBe('op-key')
		expect(r?.providerPrefs).toEqual({ zdr: true })
	})

	it('never spends the operator key for an enterprise workspace', () => {
		const r = resolveLiveCredentials({
			wsSettings: settings({ billing: { plan: 'pro' } }),
			workspace: { enterpriseGranted: true, billingOwnerId: null },
			agent,
			env,
		})
		expect(r).toBeNull()
	})

	it('returns null without any key', () => {
		expect(
			resolveLiveCredentials({ wsSettings: settings(), workspace: ws, agent, env: {} }),
		).toBeNull()
	})

	it('uses the agent model only when it is an OpenRouter id', () => {
		const good = resolveLiveCredentials({
			wsSettings: settings(),
			workspace: ws,
			agent: { llmConfig: { model: 'anthropic/claude-sonnet-5.5' } },
			env,
		})
		expect(good?.llmModel).toBe('anthropic/claude-sonnet-5.5')
		const bad = resolveLiveCredentials({
			wsSettings: settings(),
			workspace: ws,
			agent: { llmConfig: { model: 'claude-sonnet-5-5' } },
			env: { ...env, MASKIN_LIVE_MODEL: 'openai/gpt-5.5' },
		})
		expect(bad?.llmModel).toBe('openai/gpt-5.5')
	})

	it('takes the voice from agent metadata over the env default', () => {
		const r = resolveLiveCredentials({
			wsSettings: settings(),
			workspace: ws,
			agent: { metadata: { live: { enabled: true, voice: 'nova' } } },
			env: { ...env, MASKIN_LIVE_TTS_VOICE: 'echo' },
		})
		expect(r?.ttsVoice).toBe('nova')
	})
})

describe('isOpenRouterModelId', () => {
	it.each(['openai/gpt-5.5', 'deepseek/deepseek-v4.1-flash', 'qwen/qwen3:free'])(
		'accepts %s',
		(id) => {
			expect(isOpenRouterModelId(id)).toBe(true)
		},
	)
	it.each(['claude-sonnet-5-5', '', 'a b/c', undefined])('rejects %s', (id) => {
		expect(isOpenRouterModelId(id as string | undefined)).toBe(false)
	})
})
