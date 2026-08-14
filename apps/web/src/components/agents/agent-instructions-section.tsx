import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { Textarea } from '@/components/ui/textarea'
import { useUpdateActor } from '@/hooks/use-actors'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

const RUNNING_SESSIONS_WARNING =
	'Running sessions finish on the old prompt. New sessions pick this up.'
const EMPTY_PROMPT_PLACEHOLDER = 'No instructions set yet.'

export function AgentInstructionsSection({ agent }: { agent: ActorResponse }) {
	const [open, setOpen] = useState(false)
	const prompt = agent.system_prompt?.trim() ?? ''

	return (
		<section
			aria-labelledby="agent-instructions-heading"
			className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4"
		>
			<div className="flex items-center gap-2">
				<h2
					id="agent-instructions-heading"
					className="text-sm font-semibold tracking-tight text-foreground"
				>
					Instructions
				</h2>
				<span className="text-[11px] uppercase tracking-wide text-muted-foreground">
					system prompt
				</span>
				<div className="mx-2 h-px flex-1 bg-border" aria-hidden />
				<Button
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-xs font-medium"
					onClick={() => setOpen(true)}
				>
					Edit
				</Button>
			</div>
			<div className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 px-4 py-3 font-mono text-xs leading-relaxed text-muted-foreground">
				{prompt || <span className="italic">{EMPTY_PROMPT_PLACEHOLDER}</span>}
			</div>
			<AgentInstructionsEditModal agent={agent} open={open} onOpenChange={setOpen} />
		</section>
	)
}

interface EditModalProps {
	agent: ActorResponse
	open: boolean
	onOpenChange: (open: boolean) => void
}

export function AgentInstructionsEditModal({ agent, open, onOpenChange }: EditModalProps) {
	const { workspaceId } = useWorkspace()
	const updateActor = useUpdateActor(workspaceId)
	const saved = agent.system_prompt ?? ''
	const [draft, setDraft] = useState(saved)

	useEffect(() => {
		if (open) setDraft(saved)
	}, [open, saved])

	const isDirty = draft !== saved

	const handleSave = () => {
		if (!isDirty) {
			onOpenChange(false)
			return
		}
		updateActor.mutate(
			{ id: agent.id, data: { system_prompt: draft } },
			{
				onSuccess: () => {
					toast.success(RUNNING_SESSIONS_WARNING)
					onOpenChange(false)
				},
				onError: () => toast.error(`Couldn't save instructions for ${agent.name}`),
			},
		)
	}

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-2xl">
				<ResponsiveDialogHeader className="flex flex-row items-center gap-3 border-b border-border px-6 py-4 text-left">
					<ActorAvatar
						name={agent.name}
						type={agent.type}
						size="md"
						className="h-10 w-10 rounded-xl"
						id={agent.id}
					/>
					<div className="flex min-w-0 flex-1 flex-col">
						<ResponsiveDialogTitle className="truncate text-base font-semibold">
							Instructions
						</ResponsiveDialogTitle>
						<ResponsiveDialogDescription className="truncate text-xs text-muted-foreground">
							{agent.name} · system prompt
						</ResponsiveDialogDescription>
					</div>
					{isDirty && (
						<Badge
							variant="outline"
							className="border-warning/40 bg-warning/10 font-mono text-[10px] font-bold uppercase tracking-widest text-warning"
						>
							Edited
						</Badge>
					)}
				</ResponsiveDialogHeader>

				<div className="flex-1 overflow-y-auto px-6 py-4">
					<Textarea
						aria-label="System prompt"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="Write the instructions this agent should follow…"
						className="min-h-[240px] font-mono text-sm"
					/>
				</div>

				<div className="flex items-start gap-2 border-t border-border bg-muted/30 px-6 py-3 text-xs text-muted-foreground">
					<AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
					<p>{RUNNING_SESSIONS_WARNING}</p>
				</div>

				<ResponsiveDialogFooter className="flex-row items-center gap-2 border-t border-border px-6 py-3 sm:justify-between">
					<Button
						variant="ghost"
						size="sm"
						className="text-xs font-medium text-muted-foreground hover:text-foreground"
						onClick={() => setDraft(saved)}
						disabled={!isDirty}
					>
						Reset to default
					</Button>
					<div className="flex items-center gap-2">
						<Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button size="sm" onClick={handleSave} disabled={!isDirty || updateActor.isPending}>
							{updateActor.isPending ? 'Saving…' : 'Save'}
						</Button>
					</div>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
