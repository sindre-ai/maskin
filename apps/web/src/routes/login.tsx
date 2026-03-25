import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/hooks/use-auth'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/login')({
	component: LoginPage,
})

function LoginPage() {
	const { login } = useAuth()
	const [apiKey, setApiKey] = useState('')
	const [error, setError] = useState('')

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!apiKey.trim()) {
			setError('API key is required')
			return
		}
		login(apiKey.trim())
	}

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm space-y-6">
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
					<p className="mt-1 text-sm text-muted-foreground">Enter your API key to continue</p>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<Input
							type="password"
							value={apiKey}
							onChange={(e) => {
								setApiKey(e.target.value)
								setError('')
							}}
							placeholder="ank_..."
							className="font-mono"
							autoFocus
						/>
						{error && <p className="mt-1 text-xs text-error">{error}</p>}
					</div>

					<Button type="submit" className="w-full">
						Sign in
					</Button>
				</form>

				<p className="text-center text-xs text-muted-foreground">
					Don't have an account?{' '}
					<Link to="/signup" className="text-primary hover:text-primary-hover">
						Sign up
					</Link>
				</p>
			</div>
		</div>
	)
}
