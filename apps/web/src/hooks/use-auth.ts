import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useCallback } from 'react'
import { type ChangePasswordInput, type CreateActorInput, type LoginInput, api } from '../lib/api'
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
		async (data: LoginInput) => {
			const result = await api.auth.login(data)
			setApiKey(result.api_key)
			setStoredActor({
				id: result.id,
				name: result.name,
				type: result.type,
				email: result.email,
			})
			navigate({ to: '/' })
			return result
		},
		[navigate],
	)

	const signup = useCallback(
		async (data: CreateActorInput) => {
			const result = await api.actors.create(data)
			setApiKey(result.api_key)
			setStoredActor({
				id: result.id,
				name: result.name,
				type: result.type,
				email: result.email,
			})
			navigate({ to: '/' })
			return result
		},
		[navigate],
	)

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

// Rotates the API key on success so the current tab keeps a working session.
// Per T1 contract: changing the password rotates the only credential — the
// response contains the new api_key and we swap it in immediately.
export function useChangePassword() {
	return useMutation({
		mutationFn: (data: ChangePasswordInput) => api.auth.changePassword(data),
		onSuccess: (result) => {
			setApiKey(result.api_key)
		},
	})
}
