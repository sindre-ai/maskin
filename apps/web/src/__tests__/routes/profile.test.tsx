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
		auth: {
			requestEmailChange: vi.fn(),
			cancelEmailChange: vi.fn(),
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
	toast: { error: (...args: unknown[]) => toastErrorSpy(...args), success: vi.fn() },
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: vi.fn(),
	useUploadAvatar: () => ({ mutateAsync: vi.fn(), reset: vi.fn(), isPending: false }),
	useActorAvatarUrl: () => ({ data: undefined }),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
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
		avatar_storage_key: null,
		notification_prefs: {
			mentions: true,
			subscribed: true,
			betStatusChanges: true,
			weeklyDigest: false,
		},
		pending_email: null,
		isSystem: false,
		system_prompt: null,
		tools: null,
		memory: null,
		llm_provider: null,
		llm_config: null,
		agentState: 'idle',
		agentStateUpdatedAt: null,
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

describe('ProfilePage — Notification preference switches', () => {
	it('renders one switch per preference key, reflecting the actor`s saved values', () => {
		renderPage(
			buildActor({
				notification_prefs: {
					mentions: false,
					subscribed: true,
					betStatusChanges: false,
					weeklyDigest: true,
				},
			}),
		)
		expect(screen.getByRole('switch', { name: 'Mentions and replies' })).not.toBeChecked()
		expect(screen.getByRole('switch', { name: 'Subscribed objects' })).toBeChecked()
		expect(screen.getByRole('switch', { name: 'Bet status changes' })).not.toBeChecked()
		expect(screen.getByRole('switch', { name: 'Weekly digest' })).toBeChecked()
	})

	it('persists a toggle via a single-key PATCH and fires telemetry with field=notification_prefs', async () => {
		mockUpdate.mockResolvedValue(buildActor())
		renderPage()

		fireEvent.click(screen.getByRole('switch', { name: 'Weekly digest' }))

		await waitFor(() =>
			expect(mockUpdate).toHaveBeenCalledWith('actor-1', {
				notification_prefs: { weeklyDigest: true },
			}),
		)
		await waitFor(() =>
			expect(trackEventSpy).toHaveBeenCalledWith('profile.field_changed', {
				field: 'notification_prefs',
			}),
		)
	})

	it('keeps two rapid toggles on different switches independent — neither reverts the other', async () => {
		// Hold both responses open so the second click happens against a stale
		// render-time snapshot. The pre-fix behaviour sent a full merged object
		// captured from that snapshot, which silently reverted the first toggle.
		const resolvers: Array<(value: ActorResponse) => void> = []
		mockUpdate.mockImplementation(
			() =>
				new Promise<ActorResponse>((resolve) => {
					resolvers.push(resolve)
				}),
		)
		renderPage()

		fireEvent.click(screen.getByRole('switch', { name: 'Mentions and replies' }))
		fireEvent.click(screen.getByRole('switch', { name: 'Subscribed objects' }))

		await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2))

		// Both calls carry exactly one key — the one the user just toggled —
		// not a stale snapshot of the other.
		expect(mockUpdate).toHaveBeenNthCalledWith(1, 'actor-1', {
			notification_prefs: { mentions: false },
		})
		expect(mockUpdate).toHaveBeenNthCalledWith(2, 'actor-1', {
			notification_prefs: { subscribed: false },
		})

		await waitFor(() => {
			const cached = queryClient.getQueryData<ActorResponse>(['actors', 'detail', storedActor.id])
			expect(cached?.notification_prefs).toEqual({
				mentions: false,
				subscribed: false,
				betStatusChanges: true,
				weeklyDigest: false,
			})
		})

		for (const resolve of resolvers) {
			resolve(
				buildActor({
					notification_prefs: {
						mentions: false,
						subscribed: false,
						betStatusChanges: true,
						weeklyDigest: false,
					},
				}),
			)
		}
	})

	it('writes the optimistic merged prefs into the actor cache before the network resolves', async () => {
		let resolveUpdate: (value: ActorResponse) => void = () => {}
		mockUpdate.mockImplementation(
			() =>
				new Promise<ActorResponse>((resolve) => {
					resolveUpdate = resolve
				}),
		)
		renderPage()

		fireEvent.click(screen.getByRole('switch', { name: 'Mentions and replies' }))

		await waitFor(() => {
			const cached = queryClient.getQueryData<ActorResponse>(['actors', 'detail', storedActor.id])
			expect(cached?.notification_prefs.mentions).toBe(false)
		})

		resolveUpdate(
			buildActor({
				notification_prefs: {
					mentions: false,
					subscribed: true,
					betStatusChanges: true,
					weeklyDigest: false,
				},
			}),
		)
	})

	it('rolls back the cached toggle and surfaces a toast when the save fails', async () => {
		mockUpdate.mockRejectedValue(new Error('boom'))
		renderPage()

		fireEvent.click(screen.getByRole('switch', { name: 'Subscribed objects' }))

		await waitFor(() => expect(toastErrorSpy).toHaveBeenCalled())

		const cached = queryClient.getQueryData<ActorResponse>(['actors', 'detail', storedActor.id])
		expect(cached?.notification_prefs.subscribed).toBe(true)
	})

	it('describes each switch by its hint id, then swaps to the error id when the save fails', async () => {
		mockUpdate.mockRejectedValue(new Error('boom'))
		renderPage()

		const mentionsSwitch = screen.getByRole('switch', { name: 'Mentions and replies' })
		expect(mentionsSwitch).toHaveAttribute('aria-describedby', 'notification-pref-mentions-hint')
		expect(document.getElementById('notification-pref-mentions-hint')).toHaveTextContent(
			/notify me when/i,
		)

		fireEvent.click(mentionsSwitch)

		await waitFor(() => expect(toastErrorSpy).toHaveBeenCalled())
		await waitFor(() =>
			expect(screen.getByRole('switch', { name: 'Mentions and replies' })).toHaveAttribute(
				'aria-describedby',
				'notification-pref-mentions-error',
			),
		)
		expect(document.getElementById('notification-pref-mentions-error')).toHaveTextContent(
			/save failed/i,
		)
	})
})

describe('ProfilePage — Email row + verification banner', () => {
	it('renders the actor email and a Change button', () => {
		renderPage()
		expect(screen.getByText('alice@example.com')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /change email/i })).toBeInTheDocument()
	})

	it('does not render the verification banner when pending_email is null', () => {
		renderPage()
		expect(screen.queryByText(/verify your new email/i)).not.toBeInTheDocument()
	})

	it('renders the verification banner with the pending address when pending_email is set', () => {
		renderPage(buildActor({ pending_email: 'new@example.com' }))
		expect(screen.getByText(/verify your new email/i)).toBeInTheDocument()
		expect(screen.getByText('new@example.com')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /resend verification email/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /cancel email change/i })).toBeInTheDocument()
	})
})
