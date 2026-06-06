import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ActorResponse } from '@/lib/api'

const mockUpdate = vi.fn()
const trackEventSpy = vi.fn()
const toastErrorSpy = vi.fn()
const storedActor = { id: 'actor-1', name: 'Alice', type: 'human', email: null }

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/api', () => ({
	api: {
		actors: {
			get: vi.fn(),
			update: (...args: unknown[]) => mockUpdate(...args),
		},
	},
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => storedActor,
}))

vi.mock('@/lib/analytics', () => ({
	trackEvent: (...args: unknown[]) => trackEventSpy(...args),
}))

vi.mock('sonner', () => ({
	toast: { error: (...args: unknown[]) => toastErrorSpy(...args) },
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: vi.fn(),
}))

import { useActor } from '@/hooks/use-actors'
import { Route } from '@/routes/_authed/$workspaceId/profile'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const ProfilePage = (Route as unknown as { component: React.FC }).component

function buildActor(overrides: Partial<ActorResponse> = {}): ActorResponse {
	return {
		id: storedActor.id,
		type: 'human',
		name: 'Alice',
		email: 'alice@example.com',
		description: null,
		bio: null,
		isSystem: false,
		system_prompt: null,
		tools: null,
		memory: null,
		llm_provider: null,
		llm_config: null,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

let queryClient: QueryClient

function Wrapper({ children }: { children: ReactNode }) {
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function renderPage(actor: ActorResponse = buildActor({ name: 'Alice', bio: 'About me' })) {
	vi.mocked(useActor).mockReturnValue({ data: actor } as unknown as ReturnType<typeof useActor>)
	queryClient.setQueryData(['actors', 'detail', storedActor.id], actor)
	return render(<ProfilePage />, { wrapper: Wrapper })
}

beforeEach(() => {
	queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	})
	mockUpdate.mockReset()
	trackEventSpy.mockReset()
	toastErrorSpy.mockReset()
})

describe('ProfilePage — Display name + Bio rows', () => {
	it('renders the actor name and bio inside editable rows', () => {
		renderPage()
		expect(screen.getByLabelText('Display name')).toHaveValue('Alice')
		expect(screen.getByLabelText('Bio')).toHaveValue('About me')
	})

	it('saves a new display name after the debounce and fires telemetry with field=name', async () => {
		mockUpdate.mockResolvedValue(buildActor({ name: 'Alice B' }))
		renderPage()

		const input = screen.getByLabelText('Display name')
		fireEvent.change(input, { target: { value: 'Alice B' } })

		await waitFor(
			() => {
				expect(mockUpdate).toHaveBeenCalledWith('actor-1', { name: 'Alice B' })
			},
			{ timeout: 2000 },
		)

		await waitFor(() => {
			expect(trackEventSpy).toHaveBeenCalledWith('profile.field_changed', { field: 'name' })
		})
	})

	it('saves a new bio after the debounce and fires telemetry with field=bio', async () => {
		mockUpdate.mockResolvedValue(buildActor({ bio: 'Updated bio' }))
		renderPage()

		const bio = screen.getByLabelText('Bio')
		fireEvent.change(bio, { target: { value: 'Updated bio' } })

		await waitFor(
			() => {
				expect(mockUpdate).toHaveBeenCalledWith('actor-1', { bio: 'Updated bio' })
			},
			{ timeout: 2000 },
		)

		await waitFor(() => {
			expect(trackEventSpy).toHaveBeenCalledWith('profile.field_changed', { field: 'bio' })
		})
	})

	it('saves bio=null when the field is cleared (so the column is nulled, not blanked)', async () => {
		mockUpdate.mockResolvedValue(buildActor({ bio: null }))
		renderPage()

		const bio = screen.getByLabelText('Bio')
		fireEvent.change(bio, { target: { value: '' } })

		await waitFor(
			() => {
				expect(mockUpdate).toHaveBeenCalledWith('actor-1', { bio: null })
			},
			{ timeout: 2000 },
		)
	})

	it('does not save an empty display name and shows a validation hint', async () => {
		renderPage()
		fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '' } })

		expect(screen.getByText(/empty/i)).toBeInTheDocument()

		await new Promise((r) => setTimeout(r, 800))
		expect(mockUpdate).not.toHaveBeenCalled()
	})

	it('does not save a bio over the 300-character limit and shows a validation hint', async () => {
		renderPage()
		fireEvent.change(screen.getByLabelText('Bio'), { target: { value: 'x'.repeat(301) } })

		expect(screen.getByText(/over the 300-character limit/i)).toBeInTheDocument()

		await new Promise((r) => setTimeout(r, 800))
		expect(mockUpdate).not.toHaveBeenCalled()
	})

	it('rolls back the cached actor and surfaces a toast when the save fails', async () => {
		mockUpdate.mockRejectedValue(new Error('boom'))
		renderPage()

		fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Alice X' } })

		await waitFor(
			() => {
				expect(mockUpdate).toHaveBeenCalled()
			},
			{ timeout: 2000 },
		)

		await waitFor(() => {
			expect(toastErrorSpy).toHaveBeenCalled()
		})

		const cached = queryClient.getQueryData<ActorResponse>(['actors', 'detail', storedActor.id])
		expect(cached?.name).toBe('Alice')
	})

	it('does not fire telemetry when the user has not changed anything', async () => {
		renderPage()
		await new Promise((r) => setTimeout(r, 800))
		expect(mockUpdate).not.toHaveBeenCalled()
		expect(trackEventSpy).not.toHaveBeenCalledWith('profile.field_changed', expect.any(Object))
	})
})
