import {
	__resetInterpolationWarnCacheForTests,
	interpolateInstallFlowCopy,
} from '@/components/marketplace/v3/interpolate'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

describe('interpolateInstallFlowCopy', () => {
	it('returns null for an empty template', () => {
		expect(interpolateInstallFlowCopy(undefined)).toBeNull()
	})

	it('resolves all four placeholder tokens', () => {
		const out = interpolateInstallFlowCopy(
			'{agents} — adding to {team}. Reads from {integration}, {trigger_count} triggers.',
			{ integration: 'PostHog', team: 'Customer', agents: 'Sentinel, Forge', trigger_count: 2 },
		)
		const { container } = render(<div>{out}</div>)
		expect(container.textContent).toBe(
			'Sentinel, Forge — adding to Customer. Reads from PostHog, 2 triggers.',
		)
	})

	it('renders **bold** spans as <strong>', () => {
		const out = interpolateInstallFlowCopy(
			'**PostHog auth expired.** Reconnect PostHog on its integration page.',
		)
		const { container } = render(<div>{out}</div>)
		const strong = container.querySelector('strong')
		expect(strong?.textContent).toBe('PostHog auth expired.')
		expect(container.textContent).toBe(
			'PostHog auth expired. Reconnect PostHog on its integration page.',
		)
	})

	it('logs a warning and renders the raw token when a placeholder is unresolved', () => {
		__resetInterpolationWarnCacheForTests()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const out = interpolateInstallFlowCopy('needs {integration} but missing', {})
		const { container } = render(<div>{out}</div>)
		expect(container.textContent).toBe('needs {integration} but missing')
		expect(warn).toHaveBeenCalledOnce()
		expect(warn.mock.calls[0][0]).toMatch(/unresolved placeholder \{integration\}/)
		warn.mockRestore()
	})

	it('deduplicates the warning for the same token + template', () => {
		__resetInterpolationWarnCacheForTests()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		interpolateInstallFlowCopy('needs {integration}', {})
		interpolateInstallFlowCopy('needs {integration}', {})
		expect(warn).toHaveBeenCalledOnce()
		warn.mockRestore()
	})

	it('handles interleaved bold and placeholders', () => {
		const out = interpolateInstallFlowCopy(
			'Installing wires up **{agents}**, {trigger_count} triggers.',
			{ agents: 'Sentinel, Forge', trigger_count: 2 },
		)
		const { container } = render(<div>{out}</div>)
		const strong = container.querySelector('strong')
		expect(strong?.textContent).toBe('Sentinel, Forge')
		expect(container.textContent).toBe('Installing wires up Sentinel, Forge, 2 triggers.')
	})
})
