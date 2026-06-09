import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/use-auth'
import { api } from '@/lib/api'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/signup')({
	component: SignupPage,
})

function SignupPage() {
	const { signup } = useAuth()
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [confirmPassword, setConfirmPassword] = useState('')
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)

	useEffect(() => {
		const url = new URL(window.location.href)
		const pendingPrompt = url.searchParams.get('pending_prompt')
		const anonId = url.searchParams.get('anon_id')
		if (!pendingPrompt && !anonId) return

		try {
			if (pendingPrompt) {
				console.info('[maskin] imported pending prompt from URL', {
					promptChars: pendingPrompt.length,
				})
				localStorage.setItem('maskin_pending_prompt', pendingPrompt)
			}
			if (anonId) {
				localStorage.setItem('maskin_anon_id', anonId)
			}
		} catch (err) {
			console.error('[maskin] failed to import landing params from URL', err)
		}

		url.searchParams.delete('pending_prompt')
		url.searchParams.delete('anon_id')
		window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
	}, [])

	const createSessionFromPendingPrompt = async (pendingPrompt: string, signupResult: unknown) => {
		const result = signupResult as { workspace_id?: string; id?: string }
		let workspaceId = result.workspace_id

		if (!workspaceId) {
			const workspaces = await api.workspaces.list()
			const ownedWorkspace = workspaces.find((workspace) => workspace.role === 'owner')
			workspaceId = ownedWorkspace?.id
		}

		if (!workspaceId) {
			throw new Error('Could not find your workspace')
		}

		console.info('[maskin] creating session from pending prompt', {
			workspaceId,
			promptChars: pendingPrompt.length,
		})
		const actors = await api.actors.list(workspaceId)
		const agent =
			actors.find((actor) => actor.type === 'agent' && actor.name === 'Sindre') ??
			actors.find((actor) => actor.type === 'agent') ??
			null

		if (!agent) {
			throw new Error('Could not find an agent in your workspace')
		}

		await api.sessions.create(workspaceId, {
			actor_id: agent.id,
			action_prompt: pendingPrompt,
			auto_start: true,
		})
		console.info('[maskin] pending prompt session created', { workspaceId, agentId: agent.id })
	}

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!name.trim()) {
			setError('Name is required')
			return
		}
		if (!email.trim()) {
			setError('Email is required')
			return
		}
		if (password.length < 8) {
			setError('Password must be at least 8 characters')
			return
		}
		if (password !== confirmPassword) {
			setError('Passwords do not match')
			return
		}
		setLoading(true)
		try {
			const pendingPrompt = localStorage.getItem('maskin_pending_prompt')
			const anonId = localStorage.getItem('maskin_anon_id')
			const result = await signup({
				type: 'human',
				name: name.trim(),
				email: email.trim(),
				password,
			})
			if (anonId) {
				try {
					await api.landingEvents.emit([
						{ name: 'signup_complete', anonId, props: { fromGuest: true } },
					])
					localStorage.removeItem('maskin_anon_id')
				} catch {
					console.error('[maskin] failed to emit signup_complete')
				}
			}
			if (pendingPrompt) {
				try {
					await createSessionFromPendingPrompt(pendingPrompt, result)
					localStorage.removeItem('maskin_pending_prompt')
					window.location.assign('/')
				} catch (sessionErr) {
					console.error('[maskin] failed to create session from pending prompt', sessionErr)
					setError(
						sessionErr instanceof Error
							? sessionErr.message
							: 'Could not start session from your prompt',
					)
				}
			} else {
				window.location.assign('/')
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Signup failed')
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm space-y-6">
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">Create account</h1>
					<p className="mt-1 text-sm text-muted-foreground">Set up your workspace</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<Label className="mb-1 text-muted-foreground">Name</Label>
						<Input
							type="text"
							value={name}
							onChange={(e) => {
								setName(e.target.value)
								setError('')
							}}
							placeholder="Your name"
							autoFocus
						/>
					</div>

					<div>
						<Label className="mb-1 text-muted-foreground">Email</Label>
						<Input
							type="email"
							value={email}
							onChange={(e) => {
								setEmail(e.target.value)
								setError('')
							}}
							placeholder="you@example.com"
						/>
					</div>

					<div>
						<Label className="mb-1 text-muted-foreground">Password</Label>
						<Input
							type="password"
							value={password}
							onChange={(e) => {
								setPassword(e.target.value)
								setError('')
							}}
							placeholder="At least 8 characters"
						/>
					</div>

					<div>
						<Label className="mb-1 text-muted-foreground">Confirm password</Label>
						<Input
							type="password"
							value={confirmPassword}
							onChange={(e) => {
								setConfirmPassword(e.target.value)
								setError('')
							}}
							placeholder="Repeat your password"
						/>
					</div>

					{error && <p className="text-xs text-error">{error}</p>}

					<Button type="submit" disabled={loading} className="w-full">
						{loading ? 'Creating...' : 'Create account'}
					</Button>
				</form>

				<p className="text-center text-xs text-muted-foreground">
					Already have an account?{' '}
					<Link to="/login" className="text-primary hover:text-primary-hover">
						Sign in
					</Link>
				</p>
			</div>
		</div>
	)
}
