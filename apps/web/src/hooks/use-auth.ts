import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { type CreateActorInput, type LoginInput, api } from '../lib/api'
import {
	clearAuth,
	getApiKey,
	getStoredActor,
	isAuthenticated,
	setApiKey,
	setStoredActor,
} from '../lib/auth'

export function useAuth() {
	const navigate = useNavigate()

	const login = useCallback(
		async (data: LoginInput, redirectTo?: string | null) => {
			const result = await api.auth.login(data)
			setApiKey(result.api_key)
			setStoredActor({
				id: result.id,
				name: result.name,
				type: result.type,
				email: result.email,
			})
			// Sent here from a page that needed a login (the Skjald connect page): go back to it, in full, so
			// its query string survives. `redirectTo` has already been checked by `safeInternalPath`.
			if (redirectTo) window.location.assign(redirectTo)
			else navigate({ to: '/' })
			return result
		},
		[navigate],
	)

	const signup = useCallback(async (data: CreateActorInput) => {
		const result = await api.actors.create(data)
		setApiKey(result.api_key)
		setStoredActor({
			id: result.id,
			name: result.name,
			type: result.type,
			email: result.email,
		})
		return result
	}, [])

	const logout = useCallback(() => {
		clearAuth()
		navigate({ to: '/login' })
	}, [navigate])

	return {
		isAuthenticated: isAuthenticated(),
		apiKey: getApiKey(),
		actor: getStoredActor(),
		login,
		signup,
		logout,
	}
}
