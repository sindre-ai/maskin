import { Button } from '@/components/ui/button'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Check, Play, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type OnboardingTemplate, templates } from './templates'

type Step = 'choose' | 'preview' | 'complete'

export function OnboardingWizard() {
	const [step, setStep] = useState<Step>('choose')
	const [selectedTemplate, setSelectedTemplate] = useState<OnboardingTemplate | null>(null)
	const [isApplying, setIsApplying] = useState(false)
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const updateWorkspace = useUpdateWorkspace(workspaceId)

	const handleSelectTemplate = useCallback((template: OnboardingTemplate) => {
		setSelectedTemplate(template)
		setStep('preview')
	}, [])

	const handleStartFresh = useCallback(async () => {
		setIsApplying(true)
		try {
			await updateWorkspace.mutateAsync({
				settings: { onboarding_completed: true } as Record<string, unknown>,
			})
			navigate({ to: '/$workspaceId', params: { workspaceId } })
		} finally {
			setIsApplying(false)
		}
	}, [updateWorkspace, navigate, workspaceId])

	const handleApplyTemplate = useCallback(async () => {
		if (!selectedTemplate) return
		setIsApplying(true)
		try {
			await api.graph.create(workspaceId, {
				nodes: selectedTemplate.objects,
				edges: selectedTemplate.edges,
			})
			await updateWorkspace.mutateAsync({
				settings: { onboarding_completed: true } as Record<string, unknown>,
			})
			setStep('complete')
		} finally {
			setIsApplying(false)
		}
	}, [selectedTemplate, workspaceId, updateWorkspace])

	const handleCustomize = useCallback(async () => {
		if (!selectedTemplate) return
		setIsApplying(true)
		try {
			await api.graph.create(workspaceId, {
				nodes: selectedTemplate.objects,
				edges: selectedTemplate.edges,
			})
			await updateWorkspace.mutateAsync({
				settings: { onboarding_completed: true } as Record<string, unknown>,
			})
			navigate({ to: '/$workspaceId', params: { workspaceId } })
		} finally {
			setIsApplying(false)
		}
	}, [selectedTemplate, workspaceId, updateWorkspace, navigate])

	const handleFinish = useCallback(() => {
		navigate({ to: '/$workspaceId', params: { workspaceId } })
	}, [navigate, workspaceId])

	return (
		<div className="flex min-h-screen items-center justify-center bg-background p-8">
			<div className="w-full max-w-3xl">
				{step === 'choose' && (
					<ChooseStep
						onSelect={handleSelectTemplate}
						onStartFresh={handleStartFresh}
						isApplying={isApplying}
					/>
				)}
				{step === 'preview' && selectedTemplate && (
					<PreviewStep
						template={selectedTemplate}
						onBack={() => setStep('choose')}
						onApply={handleApplyTemplate}
						onCustomize={handleCustomize}
						isApplying={isApplying}
					/>
				)}
				{step === 'complete' && selectedTemplate && (
					<CompleteStep template={selectedTemplate} onFinish={handleFinish} />
				)}
			</div>
		</div>
	)
}

function ChooseStep({
	onSelect,
	onStartFresh,
	isApplying,
}: {
	onSelect: (template: OnboardingTemplate) => void
	onStartFresh: () => void
	isApplying: boolean
}) {
	return (
		<div className="space-y-8">
			<div className="text-center space-y-2">
				<h1 className="text-2xl font-semibold tracking-tight">What do you want to automate?</h1>
				<p className="text-sm text-muted-foreground">
					Pick a template to see agents in action, or start with a blank workspace.
				</p>
			</div>

			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{templates.map((template) => {
					const Icon = template.icon
					return (
						<button
							key={template.id}
							type="button"
							onClick={() => onSelect(template)}
							className="group rounded-lg border border-border bg-card p-5 text-left transition-all hover:border-primary/30 hover:bg-accent/30"
						>
							<div className="flex items-start gap-3">
								<div className="mt-0.5">
									<Icon size={20} className={template.color} />
								</div>
								<div className="min-w-0">
									<p className="text-sm font-medium text-foreground">{template.name}</p>
									<p className="mt-1 text-xs text-muted-foreground leading-relaxed">
										{template.description}
									</p>
								</div>
							</div>
						</button>
					)
				})}
			</div>

			<div className="flex justify-center">
				<Button variant="ghost" onClick={onStartFresh} disabled={isApplying}>
					{isApplying ? 'Setting up...' : 'Start with a blank workspace'}
					<ArrowRight size={15} />
				</Button>
			</div>
		</div>
	)
}

function PreviewStep({
	template,
	onBack,
	onApply,
	onCustomize,
	isApplying,
}: {
	template: OnboardingTemplate
	onBack: () => void
	onApply: () => void
	onCustomize: () => void
	isApplying: boolean
}) {
	return (
		<div className="space-y-8">
			<div className="text-center space-y-2">
				<h1 className="text-2xl font-semibold tracking-tight">{template.name}</h1>
				<p className="text-sm text-muted-foreground">{template.description}</p>
			</div>

			<AgentActivitySimulation activity={template.simulatedActivity} />

			<div className="space-y-3">
				<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
					What gets created
				</p>
				<div className="space-y-2">
					{template.objects.map((obj) => (
						<div
							key={obj.$id}
							className="flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3"
						>
							<TypeIndicator type={obj.type} />
							<span className="text-sm text-foreground">{obj.title}</span>
						</div>
					))}
				</div>
			</div>

			<div className="flex items-center justify-between">
				<Button variant="ghost" onClick={onBack} disabled={isApplying}>
					<ArrowLeft size={15} />
					Back
				</Button>
				<div className="flex gap-2">
					<Button variant="outline" onClick={onCustomize} disabled={isApplying}>
						{isApplying ? 'Setting up...' : 'Use this & customize'}
					</Button>
					<Button onClick={onApply} disabled={isApplying}>
						{isApplying ? (
							'Creating workspace...'
						) : (
							<>
								<Play size={15} />
								Use this template
							</>
						)}
					</Button>
				</div>
			</div>
		</div>
	)
}

function CompleteStep({
	template,
	onFinish,
}: {
	template: OnboardingTemplate
	onFinish: () => void
}) {
	return (
		<div className="space-y-8 text-center">
			<div className="flex justify-center">
				<div className="flex h-16 w-16 items-center justify-center rounded-full bg-status-done-bg">
					<Check size={28} className="text-status-done-text" />
				</div>
			</div>

			<div className="space-y-2">
				<h1 className="text-2xl font-semibold tracking-tight">You're all set</h1>
				<p className="text-sm text-muted-foreground">
					Your workspace is loaded with the{' '}
					<span className="font-medium text-foreground">{template.name}</span> template. Everything
					is ready to explore and customize.
				</p>
			</div>

			<Button onClick={onFinish} size="lg">
				<Sparkles size={15} />
				Go to your workspace
			</Button>
		</div>
	)
}

function AgentActivitySimulation({ activity }: { activity: string[] }) {
	const [visibleLines, setVisibleLines] = useState(0)
	const intervalRef = useRef<ReturnType<typeof setInterval>>(null)

	useEffect(() => {
		setVisibleLines(0)
		intervalRef.current = setInterval(() => {
			setVisibleLines((prev) => {
				if (prev >= activity.length) {
					if (intervalRef.current) clearInterval(intervalRef.current)
					return prev
				}
				return prev + 1
			})
		}, 800)

		return () => {
			if (intervalRef.current) clearInterval(intervalRef.current)
		}
	}, [activity])

	return (
		<div className="rounded-lg border border-border bg-card p-4">
			<div className="flex items-center gap-2 mb-3">
				<div className="h-2 w-2 rounded-full bg-success animate-pulse" />
				<span className="text-xs font-medium text-muted-foreground">Agent activity</span>
			</div>
			<div className="space-y-1.5 font-mono text-xs">
				{activity.slice(0, visibleLines).map((line, i) => (
					<div
						key={line}
						className="text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-300"
						style={{ animationDelay: `${i * 100}ms` }}
					>
						<span className="text-foreground/40 mr-2">$</span>
						{line}
					</div>
				))}
				{visibleLines < activity.length && (
					<div className="text-muted-foreground/50">
						<span className="inline-block w-1.5 h-3.5 bg-foreground/30 animate-pulse" />
					</div>
				)}
			</div>
		</div>
	)
}

function TypeIndicator({ type }: { type: string }) {
	const colors: Record<string, string> = {
		insight: 'bg-type-insight-bg text-type-insight-text',
		bet: 'bg-type-bet-bg text-type-bet-text',
		task: 'bg-type-task-bg text-type-task-text',
	}

	return (
		<span
			className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${colors[type] ?? 'bg-muted text-muted-foreground'}`}
		>
			{type}
		</span>
	)
}
