import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
}))

vi.mock('@/lib/api', () => ({
	api: {
		auth: { login: vi.fn() },
		actors: { create: vi.fn() },
	},
}))

vi.mock('@/lib/auth', () => ({
	clearAuth: vi.fn(),
	getApiKey: vi.fn(),
	getStoredActor: vi.fn(),
	isAuthenticated: vi.fn(),
	setApiKey: vi.fn(),
	setStoredActor: vi.fn(),
}))

import { useAuth } from '@/hooks/use-auth'
import { api } from '@/lib/api'
import {
	clearAuth,
	getApiKey,
	getStoredActor,
	isAuthenticated,
	setApiKey,
	setStoredActor,
} from '@/lib/auth'
import { buildActorWithKey } from '../factories'
import { TestWrapper } from '../setup'

beforeEach(() => {
	vi.clearAllMocks()
})

const mockActorResult = buildActorWithKey({
	id: 'actor-1',
	name: 'Test User',
	email: 'test@example.com',
})

describe('useAuth', () => {
	describe('login', () => {
		it('calls API, stores credentials, and navigates to /', async () => {
			vi.mocked(api.auth.login).mockResolvedValue(mockActorResult)

			const { result } = renderHook(() => useAuth(), { wrapper: TestWrapper })

			await act(async () => {
				await result.current.login({ email: 'test@example.com', password: 'pass' })
			})

			expect(api.auth.login).toHaveBeenCalledWith({ email: 'test@example.com', password: 'pass' })
			expect(setApiKey).toHaveBeenCalledWith('ank_test123')
			expect(setStoredActor).toHaveBeenCalledWith({
				id: 'actor-1',
				name: 'Test User',
				type: 'human',
				email: 'test@example.com',
			})
			expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
		})
	})

	describe('signup', () => {
		it('calls API, stores credentials, and navigates to /', async () => {
			vi.mocked(api.actors.create).mockResolvedValue(mockActorResult)

			const { result } = renderHook(() => useAuth(), { wrapper: TestWrapper })

			await act(async () => {
				await result.current.signup({ type: 'human', name: 'Test User' })
			})

			expect(api.actors.create).toHaveBeenCalledWith({ type: 'human', name: 'Test User' })
			expect(setApiKey).toHaveBeenCalledWith('ank_test123')
			expect(setStoredActor).toHaveBeenCalledWith({
				id: 'actor-1',
				name: 'Test User',
				type: 'human',
				email: 'test@example.com',
			})
			expect(mockNavigate).toHaveBeenCalledWith({ to: '/' })
		})
	})

	describe('logout', () => {
		it('clears auth and navigates to /login', () => {
			const { result } = renderHook(() => useAuth(), { wrapper: TestWrapper })

			act(() => {
				result.current.logout()
			})

			expect(clearAuth).toHaveBeenCalled()
			expect(mockNavigate).toHaveBeenCalledWith({ to: '/login' })
		})
	})

	describe('state getters', () => {
		it('returns isAuthenticated from auth module', () => {
			vi.mocked(isAuthenticated).mockReturnValue(true)

			const { result } = renderHook(() => useAuth(), { wrapper: TestWrapper })

			expect(result.current.isAuthenticated).toBe(true)
		})

		it('returns apiKey from auth module', () => {
			vi.mocked(getApiKey).mockReturnValue('ank_key')

			const { result } = renderHook(() => useAuth(), { wrapper: TestWrapper })

			expect(result.current.apiKey).toBe('ank_key')
		})

		it('returns actor from auth module', () => {
			const actor = { id: 'a1', name: 'A', type: 'human', email: null }
			vi.mocked(getStoredActor).mockReturnValue(actor)

			const { result } = renderHook(() => useAuth(), { wrapper: TestWrapper })

			expect(result.current.actor).toEqual(actor)
		})
	})
})
