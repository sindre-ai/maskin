import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
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
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

const RUNNING_SESSIONS_WARNING =
	'Running sessions finish on the old prompt. New sessions pick this up.'
const EMPTY_PROMPT_PLACEHOLDER = 'No instructions set yet.'
/** Paragraphs shown before the prompt collapses (mockup 2502–2504). */
const COLLAPSED_PARAGRAPHS = 2

function splitParagraphs(prompt: string): string[] {
	return prompt
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean)
}

/** "N paragraphs · N words" for the modal's meta line (mockup 3089). */
export function describeDraft(draft: string): string {
	const paragraphs = splitParagraphs(draft).length
	const words = draft.trim() ? draft.trim().split(/\s+/).length : 0
	return `${paragraphs} paragraph${paragraphs === 1 ? '' : 's'} · ${words} word${
		words === 1 ? '' : 's'
	}`
}

export function AgentInstructionsSection({ agent }: { agent: ActorResponse }) {
	const [open, setOpen] = useState(false)
	const [expanded, setExpanded] = useState(false)
	const prompt = agent.system_prompt?.trim() ?? ''

	const paragraphs = useMemo(() => splitParagraphs(prompt), [prompt])
	const lineCount = prompt ? prompt.split('\n').length : 0
	// A long system prompt otherwise pushes every following section off screen.
	const isTruncatable = paragraphs.length > COLLAPSED_PARAGRAPHS
	const shown = expanded || !isTruncatable ? paragraphs : paragraphs.slice(0, COLLAPSED_PARAGRAPHS)

	return (
		<section aria-labelledby="agent-instructions-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="agent-instructions-heading"
				title="Instructions"
				note="system prompt"
				action={
					<Button
						variant="ghost"
						size="sm"
						className="h-7 shrink-0 px-2 text-xs font-medium"
						onClick={() => setOpen(true)}
					>
						Edit
					</Button>
				}
			/>
			<div className="rounded-xl border border-border bg-muted/40 px-4 py-4 text-[12.5px] leading-[1.65] text-foreground">
				{prompt ? (
					<div className="flex flex-col gap-2.5">
						{shown.map((paragraph, i) => (
							// Paragraph order is the content's identity here — the prompt has
							// no per-paragraph key.
							// biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are positional
							<p key={i} className="whitespace-pre-wrap">
								{paragraph}
							</p>
						))}
						{isTruncatable && (
							<Button
								variant="ghost"
								size="sm"
								className="h-7 w-fit px-2 text-[11.5px] font-medium text-muted-foreground hover:text-foreground"
								aria-expanded={expanded}
								onClick={() => setExpanded((v) => !v)}
							>
								{expanded ? 'Show less' : `Show all ${lineCount} lines`}
								{expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
							</Button>
						)}
					</div>
				) : (
					<span className="italic text-muted-foreground">{EMPTY_PROMPT_PLACEHOLDER}</span>
				)}
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
					toast.success('Instructions saved')
					onOpenChange(false)
				},
				onError: () => toast.error(`Couldn't save instructions for ${agent.name}`),
			},
		)
	}

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent className="flex max-h-[85dvh] flex-col gap-0 p-0 shadow-xl sm:max-w-2xl sm:rounded-2xl">
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
					{/* There is no stored "default" prompt to diff against, so this badge
					    reports what it can actually know: there are unsaved changes. */}
					{isDirty && (
						<Badge
							variant="outline"
							className="border-warning/40 bg-warning/10 font-mono text-[10px] font-bold uppercase tracking-widest text-warning"
						>
							Unsaved
						</Badge>
					)}
				</ResponsiveDialogHeader>

				<div className="flex-1 overflow-y-auto px-6 py-4">
					<Textarea
						aria-label="System prompt"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="Describe what this agent should always do — one idea per paragraph."
						className="min-h-[240px] text-[12.5px] leading-[1.7]"
					/>
				</div>

				<div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 border-t border-border bg-muted/30 px-6 py-3 text-xs text-muted-foreground">
					{/* Mockup 3089 — the shape of what you're about to save, beside the
					    warning about when it takes effect. */}
					<span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider tabular-nums">
						{describeDraft(draft)}
					</span>
					<span className="flex min-w-[140px] flex-1 items-start gap-2">
						<AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
						<span>{RUNNING_SESSIONS_WARNING}</span>
					</span>
				</div>

				<ResponsiveDialogFooter className="flex-row items-center gap-2 border-t border-border px-6 py-3 sm:justify-between">
					<Button
						variant="ghost"
						size="sm"
						className="text-xs font-medium text-muted-foreground hover:text-foreground"
						onClick={() => setDraft(saved)}
						disabled={!isDirty}
					>
						Revert changes
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
