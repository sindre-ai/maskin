import { Button } from '@/components/ui/button'
import { clearAuth } from '@/lib/auth'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, X } from 'lucide-react'
import { useState } from 'react'

export function isPlaygroundSession(): boolean {
	return localStorage.getItem('maskin-playground') === 'true'
}

export function PlaygroundBanner() {
	const [dismissed, setDismissed] = useState(false)
	const navigate = useNavigate()

	if (!isPlaygroundSession() || dismissed) return null

	const handleSignup = () => {
		// Clear playground flag and auth, redirect to signup
		localStorage.removeItem('maskin-playground')
		clearAuth()
		navigate({ to: '/signup' })
	}

	return (
		<div className="flex items-center justify-between gap-4 border-b border-accent/20 bg-accent/5 px-4 py-2">
			<p className="text-xs text-text-secondary">
				<span className="font-medium text-accent">Playground</span> — You're exploring a demo
				workspace. Sign up to save your work.
			</p>
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="sm" onClick={handleSignup} className="h-6 gap-1 text-xs">
					Sign up
					<ArrowRight size={12} />
				</Button>
				<a
					href="https://github.com/sindre-ai/maskin#quick-start"
					target="_blank"
					rel="noopener noreferrer"
					className="text-xs text-text-secondary hover:text-accent"
				>
					Deploy your own
				</a>
				<button
					type="button"
					onClick={() => setDismissed(true)}
					className="text-text-secondary hover:text-text"
				>
					<X size={14} />
				</button>
			</div>
		</div>
	)
}
