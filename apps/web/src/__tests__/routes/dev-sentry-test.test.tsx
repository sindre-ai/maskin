import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/sentry', () => ({
	captureException: vi.fn(),
}))

import { captureException } from '@/lib/sentry'
import { Route } from '@/routes/dev/sentry-test'
import type { ReactElement } from 'react'

type RouteWithComponent = { component: () => ReactElement }

function renderComponent() {
	const { component: Component } = Route as unknown as RouteWithComponent
	return render(<Component />)
}

beforeEach(() => {
	vi.mocked(captureException).mockReset()
	vi.unstubAllEnvs()
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('dev/sentry-test route', () => {
	it('renders the throw button enabled in dev mode', () => {
		vi.stubEnv('DEV', true)
		vi.stubEnv('VITE_SENTRY_FORCE_ENABLE', '')

		renderComponent()

		expect(screen.getByRole('button', { name: /throw a test exception/i })).not.toBeDisabled()
	})

	it('renders the button disabled and shows the explanatory copy in non-dev without the force-enable flag', () => {
		vi.stubEnv('DEV', false)
		vi.stubEnv('VITE_SENTRY_FORCE_ENABLE', '')

		renderComponent()

		expect(screen.getByRole('button', { name: /throw a test exception/i })).toBeDisabled()
		expect(screen.getByText(/isn't a Vite dev build/i)).toBeInTheDocument()
	})

	it('enables the button when VITE_SENTRY_FORCE_ENABLE is set, even in production builds', () => {
		vi.stubEnv('DEV', false)
		vi.stubEnv('VITE_SENTRY_FORCE_ENABLE', 'true')

		renderComponent()

		expect(screen.getByRole('button', { name: /throw a test exception/i })).not.toBeDisabled()
	})

	it('forwards the error to captureException so a live Sentry client would receive it', async () => {
		vi.stubEnv('DEV', true)
		vi.stubEnv('VITE_SENTRY_FORCE_ENABLE', '')

		renderComponent()
		await userEvent.click(screen.getByRole('button', { name: /throw a test exception/i }))

		expect(vi.mocked(captureException)).toHaveBeenCalledOnce()
		const arg = vi.mocked(captureException).mock.calls[0][0]
		expect(arg).toBeInstanceOf(Error)
		expect((arg as Error).message).toMatch(/Sentry test exception from apps\/web/i)
	})
})
