import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

async function renderSecurityPage() {
	const { Route } = await import('@/routes/security')
	const SecurityPage = (Route as unknown as { component: React.FC }).component
	render(<SecurityPage />)
}

describe('SecurityPage', () => {
	beforeEach(() => {
		vi.resetModules()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('renders the security page heading', async () => {
		await renderSecurityPage()
		expect(screen.getByRole('heading', { level: 1, name: 'Security' })).toBeInTheDocument()
	})

	it('names Magnus as compliance owner of record', async () => {
		await renderSecurityPage()
		expect(screen.getByRole('heading', { level: 2, name: 'Compliance owner' })).toBeInTheDocument()
		expect(screen.getByText(/Magnus is our compliance owner of record/)).toBeInTheDocument()
	})

	it('hides the observation-underway line when the flag is unset', async () => {
		vi.stubEnv('VITE_SOC2_OBSERVATION_UNDERWAY', '')
		await renderSecurityPage()
		expect(screen.queryByText(/observation period underway/i)).not.toBeInTheDocument()
		expect(
			screen.getByText(/observation status on this page once the observation period begins/i),
		).toBeInTheDocument()
	})

	it('hides the observation-underway line when the flag is any string other than "true"', async () => {
		vi.stubEnv('VITE_SOC2_OBSERVATION_UNDERWAY', 'false')
		await renderSecurityPage()
		expect(screen.queryByText(/observation period underway/i)).not.toBeInTheDocument()
	})

	it('renders the observation-underway line only when the flag is exactly "true"', async () => {
		vi.stubEnv('VITE_SOC2_OBSERVATION_UNDERWAY', 'true')
		await renderSecurityPage()
		expect(screen.getByText(/observation period underway/i)).toBeInTheDocument()
	})
})
