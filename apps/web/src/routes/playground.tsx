import { Button } from '@/components/ui/button'
import { setApiKey, setStoredActor } from '@/lib/auth'
import { API_BASE } from '@/lib/constants'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Bot, Github, Layers, Play, Zap } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/playground')({
	component: PlaygroundPage,
})

interface ProvisionResponse {
	api_key: string
	actor: {
		id: string
		name: string
		type: string
		email: string | null
	}
	workspace_id: string
}

function PlaygroundPage() {
	const navigate = useNavigate()
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState('')

	const handleTryNow = async () => {
		setLoading(true)
		setError('')
		try {
			const res = await fetch(`${API_BASE}/playground/provision`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
			})

			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: { message: res.statusText } }))
				throw new Error(
					typeof data.error === 'object' ? data.error.message : data.error || 'Provision failed',
				)
			}

			const data: ProvisionResponse = await res.json()

			// Store auth credentials
			setApiKey(data.api_key)
			setStoredActor({
				id: data.actor.id,
				name: data.actor.name,
				type: data.actor.type,
				email: data.actor.email,
			})

			// Mark this session as playground
			localStorage.setItem('maskin-playground', 'true')

			// Navigate to the provisioned workspace
			navigate({ to: '/$workspaceId', params: { workspaceId: data.workspace_id } })
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Something went wrong')
		} finally {
			setLoading(false)
		}
	}

	return (
		<div className="min-h-screen bg-background">
			{/* Hero */}
			<div className="flex flex-col items-center justify-center px-6 pt-24 pb-16">
				<div className="mb-8 flex items-center gap-2 rounded-full border border-border bg-bg-surface px-4 py-1.5 text-xs text-text-secondary">
					<Zap size={14} className="text-accent" />
					<span>Open source agent workspace platform</span>
				</div>

				<h1 className="max-w-2xl text-center text-4xl font-semibold tracking-tight sm:text-5xl">
					See your agents work.
					<br />
					<span className="text-accent">Steer what matters.</span>
				</h1>

				<p className="mt-6 max-w-lg text-center text-base text-text-secondary leading-relaxed">
					Maskin is where autonomous agents run and humans steer. Explore a live workspace with
					agents, insights, bets, and tasks — no signup or install required.
				</p>

				<div className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
					<Button size="lg" onClick={handleTryNow} disabled={loading} className="gap-2 px-6">
						{loading ? (
							<>
								<span className="animate-spin">⟳</span>
								Setting up your workspace...
							</>
						) : (
							<>
								<Play size={16} />
								Try it now — no signup needed
							</>
						)}
					</Button>

					<Button variant="outline" size="lg" asChild className="gap-2 px-6">
						<a href="https://github.com/sindre-ai/maskin" target="_blank" rel="noopener noreferrer">
							<Github size={16} />
							Deploy your own
						</a>
					</Button>
				</div>

				{error && <p className="mt-4 text-sm text-error">{error}</p>}
			</div>

			{/* Feature highlights */}
			<div className="mx-auto max-w-4xl px-6 pb-24">
				<div className="grid gap-6 sm:grid-cols-3">
					<FeatureCard
						icon={<Bot size={20} className="text-accent" />}
						title="Autonomous agents"
						description="Agents run in isolated containers with full tool access. Watch them work in real-time via live logs."
					/>
					<FeatureCard
						icon={<Layers size={20} className="text-accent" />}
						title="Bet-centric steering"
						description="Organize work around strategic bets. Agents handle insights and tasks — you steer the direction."
					/>
					<FeatureCard
						icon={<Zap size={20} className="text-accent" />}
						title="Event-driven automation"
						description="Triggers fire agents on schedules or events. Connect GitHub, Slack, and more via integrations."
					/>
				</div>

				<div className="mt-16 text-center">
					<p className="text-sm text-text-secondary">
						Ready to run it yourself?{' '}
						<a
							href="https://github.com/sindre-ai/maskin#quick-start"
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-accent hover:underline"
						>
							Self-host in one command
							<ArrowRight size={14} />
						</a>
					</p>
				</div>
			</div>
		</div>
	)
}

function FeatureCard({
	icon,
	title,
	description,
}: {
	icon: React.ReactNode
	title: string
	description: string
}) {
	return (
		<div className="rounded-lg border border-border bg-bg-surface p-6">
			<div className="mb-3">{icon}</div>
			<h3 className="text-sm font-medium">{title}</h3>
			<p className="mt-1.5 text-sm text-text-secondary leading-relaxed">{description}</p>
		</div>
	)
}
