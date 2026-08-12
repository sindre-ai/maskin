import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
}))

const mockSignInWithOtp = vi.fn()
const mockGetSession = vi.fn()
const mockSignOut = vi.fn()
const mockCreateClient = vi.fn(() => ({
	auth: {
		signInWithOtp: mockSignInWithOtp,
		getSession: mockGetSession,
		signOut: mockSignOut,
	},
}))
vi.mock('@supabase/supabase-js', () => ({
	createClient: () => mockCreateClient(),
}))

const mockLink = vi.fn()
const mockActorsUpdate = vi.fn()
const mockObjectsCreate = vi.fn()
vi.mock('@/lib/api', () => ({
	api: {
		vaerkstedAuth: { link: (...args: unknown[]) => mockLink(...args) },
		actors: { update: (...args: unknown[]) => mockActorsUpdate(...args) },
		objects: { create: (...args: unknown[]) => mockObjectsCreate(...args) },
	},
}))

const mockSetApiKey = vi.fn()
const mockSetStoredActor = vi.fn()
const mockGetStoredActor = vi.fn()
vi.mock('@/lib/auth', () => ({
	setApiKey: (...args: unknown[]) => mockSetApiKey(...args),
	setStoredActor: (...args: unknown[]) => mockSetStoredActor(...args),
	getStoredActor: () => mockGetStoredActor(),
}))

import { useVaerkstedAuth } from '@/hooks/use-vaerksted-auth'

const PENDING_PROFILE_KEY = 'maskin_vaerksted_pending_profile'

function mockFetchIdentities(sessionToken = 'session-token-1') {
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ session_token: sessionToken }),
		}),
	)
}

describe('useVaerkstedAuth', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		localStorage.clear()
		vi.stubEnv('VITE_VAERKSTED_SUPABASE_URL', 'https://vaerksted.test.supabase.co')
		vi.stubEnv('VITE_VAERKSTED_SUPABASE_ANON_KEY', 'anon-key')
		vi.stubEnv('VITE_VAERKSTED_AUTH_BASE_URL', 'http://vaerksted-auth.test')
		mockGetSession.mockResolvedValue({ data: { session: null } })
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		localStorage.clear()
	})

	describe('sendMagicLink', () => {
		it('sends the magic link and does not stash a profile when none is given (login)', async () => {
			mockSignInWithOtp.mockResolvedValue({ error: null })
			const { result } = renderHook(() => useVaerkstedAuth())

			await act(async () => {
				await result.current.sendMagicLink('test@example.com')
			})

			expect(mockSignInWithOtp).toHaveBeenCalledWith({
				email: 'test@example.com',
				options: { emailRedirectTo: expect.any(String) },
			})
			expect(localStorage.getItem(PENDING_PROFILE_KEY)).toBeNull()
		})

		it('stashes the profile in localStorage (not sessionStorage) when given (signup)', async () => {
			mockSignInWithOtp.mockResolvedValue({ error: null })
			const { result } = renderHook(() => useVaerkstedAuth())

			await act(async () => {
				await result.current.sendMagicLink('test@example.com', {
					name: 'Ada Lovelace',
					organization: 'Analytical Engines',
					role: 'Mathematician',
				})
			})

			expect(JSON.parse(localStorage.getItem(PENDING_PROFILE_KEY) ?? '')).toEqual({
				name: 'Ada Lovelace',
				organization: 'Analytical Engines',
				role: 'Mathematician',
			})
		})

		it('throws when vaerksted env vars are not configured', async () => {
			// getVaerkstedSupabaseClient() caches its result in module-level state
			// (deliberately — see the doc comment in use-vaerksted-auth.ts) so an
			// earlier test's successful client creation would otherwise leak into
			// this one. Reset modules and re-import fresh so this test observes a
			// clean cache. Explicitly stub empty strings rather than
			// vi.unstubAllEnvs() — this dev sandbox has a real apps/web/.env with
			// live vaerksted credentials (used for manual E2E testing), so
			// "unstubbed" reverts to genuinely-configured values here, not to
			// unset ones.
			vi.stubEnv('VITE_VAERKSTED_SUPABASE_URL', '')
			vi.stubEnv('VITE_VAERKSTED_SUPABASE_ANON_KEY', '')
			vi.stubEnv('VITE_VAERKSTED_AUTH_BASE_URL', '')
			vi.resetModules()
			const { useVaerkstedAuth: freshUseVaerkstedAuth } = await import('@/hooks/use-vaerksted-auth')
			const { result } = renderHook(() => freshUseVaerkstedAuth())

			await act(async () => {
				await expect(result.current.sendMagicLink('test@example.com')).rejects.toThrow(
					'vaerksted sign-in is not configured',
				)
			})
		})
	})

	describe('completeFromRedirect', () => {
		it('resolves to null with no pending Supabase session (the common case)', async () => {
			mockGetSession.mockResolvedValue({ data: { session: null } })
			const { result } = renderHook(() => useVaerkstedAuth())

			const value = await act(async () => result.current.completeFromRedirect())

			expect(value).toBeNull()
			expect(mockLink).not.toHaveBeenCalled()
			expect(mockNavigate).not.toHaveBeenCalled()
		})

		it('applies a stashed profile for a brand-new actor: renames it and writes the signup-capture knowledge object', async () => {
			localStorage.setItem(
				PENDING_PROFILE_KEY,
				JSON.stringify({
					name: 'Ada Lovelace',
					organization: 'Analytical Engines',
					role: 'Mathematician',
				}),
			)
			mockGetSession.mockResolvedValue({ data: { session: { access_token: 'sb-token' } } })
			mockFetchIdentities()
			mockLink.mockResolvedValue({
				id: 'actor-1',
				name: 'test@example.com',
				email: 'test@example.com',
				type: 'human',
				api_key: 'ank_abc',
				workspace_id: 'ws-1',
				is_new_actor: true,
			})
			mockActorsUpdate.mockResolvedValue({})
			mockObjectsCreate.mockResolvedValue({})

			const { result } = renderHook(() => useVaerkstedAuth())
			const value = await act(async () => result.current.completeFromRedirect())

			expect(mockActorsUpdate).toHaveBeenCalledWith('actor-1', { name: 'Ada Lovelace' }, 'ws-1')
			expect(mockObjectsCreate).toHaveBeenCalledTimes(1)
			const [workspaceId, payload] = mockObjectsCreate.mock.calls[0]
			expect(workspaceId).toBe('ws-1')
			expect(payload.type).toBe('knowledge')
			expect(payload.metadata.name).toBe('Ada Lovelace')
			expect(payload.metadata.organization).toBe('Analytical Engines')
			expect(payload.metadata.role).toBe('Mathematician')
			// Consumed — must not leak into a later, unrelated signup attempt.
			expect(localStorage.getItem(PENDING_PROFILE_KEY)).toBeNull()
			expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
			expect(value?.id).toBe('actor-1')
		})

		it('discards a stashed profile without applying it when the actor is not new (login / link-by-email)', async () => {
			localStorage.setItem(
				PENDING_PROFILE_KEY,
				JSON.stringify({ name: 'Stale', organization: 'Stale Co', role: 'Stale Role' }),
			)
			mockGetSession.mockResolvedValue({ data: { session: { access_token: 'sb-token' } } })
			mockFetchIdentities()
			mockLink.mockResolvedValue({
				id: 'actor-2',
				name: 'Existing User',
				email: 'existing@example.com',
				type: 'human',
				api_key: 'ank_def',
				workspace_id: 'ws-2',
				is_new_actor: false,
			})

			const { result } = renderHook(() => useVaerkstedAuth())
			await act(async () => result.current.completeFromRedirect())

			expect(mockActorsUpdate).not.toHaveBeenCalled()
			expect(mockObjectsCreate).not.toHaveBeenCalled()
			expect(localStorage.getItem(PENDING_PROFILE_KEY)).toBeNull()
			expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
		})

		it('routes to /complete-profile (not "/") for a new actor with no stashed profile — e.g. a never-before-seen email typed into /login', async () => {
			mockGetSession.mockResolvedValue({ data: { session: { access_token: 'sb-token' } } })
			mockFetchIdentities()
			mockLink.mockResolvedValue({
				id: 'actor-3',
				name: 'test@example.com',
				email: 'test@example.com',
				type: 'human',
				api_key: 'ank_ghi',
				workspace_id: 'ws-3',
				is_new_actor: true,
			})

			const { result } = renderHook(() => useVaerkstedAuth())
			await act(async () => result.current.completeFromRedirect())

			expect(mockActorsUpdate).not.toHaveBeenCalled()
			expect(mockObjectsCreate).not.toHaveBeenCalled()
			expect(mockNavigate).toHaveBeenCalledWith({
				to: '/complete-profile',
				search: { workspace_id: 'ws-3' },
			})
			expect(mockNavigate).not.toHaveBeenCalledWith({ to: '/' })
		})

		it('sets the API key and stores the actor before navigating', async () => {
			mockGetSession.mockResolvedValue({ data: { session: { access_token: 'sb-token' } } })
			mockFetchIdentities()
			mockLink.mockResolvedValue({
				id: 'actor-4',
				name: 'Existing User',
				email: 'existing@example.com',
				type: 'human',
				api_key: 'ank_jkl',
				is_new_actor: false,
			})

			const { result } = renderHook(() => useVaerkstedAuth())
			await act(async () => result.current.completeFromRedirect())

			expect(mockSetApiKey).toHaveBeenCalledWith('ank_jkl')
			expect(mockSetStoredActor).toHaveBeenCalledWith({
				id: 'actor-4',
				name: 'Existing User',
				type: 'human',
				email: 'existing@example.com',
			})
			await waitFor(() => expect(mockSignOut).toHaveBeenCalled())
		})
	})

	describe('submitProfile', () => {
		it('renames the currently-stored actor, writes the knowledge object, and navigates home', async () => {
			mockGetStoredActor.mockReturnValue({
				id: 'actor-5',
				name: 'test@example.com',
				type: 'human',
				email: 'test@example.com',
			})
			mockActorsUpdate.mockResolvedValue({})
			mockObjectsCreate.mockResolvedValue({})

			const { result } = renderHook(() => useVaerkstedAuth())
			await act(async () => {
				await result.current.submitProfile('ws-5', {
					name: 'Ada Lovelace',
					organization: 'Analytical Engines',
					role: 'Mathematician',
				})
			})

			expect(mockActorsUpdate).toHaveBeenCalledWith('actor-5', { name: 'Ada Lovelace' }, 'ws-5')
			expect(mockObjectsCreate).toHaveBeenCalledTimes(1)
			const [workspaceId, payload] = mockObjectsCreate.mock.calls[0]
			expect(workspaceId).toBe('ws-5')
			expect(payload.metadata.organization).toBe('Analytical Engines')
			expect(payload.metadata.role).toBe('Mathematician')
			expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
		})

		it('redirects to /login instead of throwing when there is no stored actor', async () => {
			mockGetStoredActor.mockReturnValue(null)

			const { result } = renderHook(() => useVaerkstedAuth())
			await act(async () => {
				await result.current.submitProfile('ws-6', {
					name: 'Ada Lovelace',
					organization: 'Analytical Engines',
					role: 'Mathematician',
				})
			})

			expect(mockActorsUpdate).not.toHaveBeenCalled()
			expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' })
		})
	})
})
