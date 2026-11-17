import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useUpdateActor } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import type { ActorResponse } from '@/lib/api'
import { PILL_BUTTON } from '@/lib/pill-button'
import { useWorkspace } from '@/lib/workspace-context'
import { useState } from 'react'
import { toast } from 'sonner'

/** The person's system prompt: what agents read when they are @mentioned in a comment. */
export function PersonAgentContext({
	person,
	firstName,
}: {
	person: ActorResponse
	firstName: string
}) {
	const { workspaceId } = useWorkspace()
	const updateActor = useUpdateActor(workspaceId)
	const canWrite = useCanWrite()
	const saved = person.system_prompt ?? ''
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(saved)

	const save = () => {
		if (draft === saved) {
			setEditing(false)
			return
		}
		updateActor.mutate(
			{ id: person.id, data: { system_prompt: draft } },
			{
				onSuccess: () => setEditing(false),
				onError: () => toast.error(`Couldn't save what agents know about ${firstName}`),
			},
		)
	}

	return (
		<section aria-labelledby="person-context-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="person-context-heading"
				title={`What agents know about ${firstName}`}
				action={
					!editing && (
						<ViewerTooltip>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 shrink-0 px-2 text-[13px] font-semibold text-muted-foreground hover:text-foreground"
								disabled={!canWrite}
								onClick={() => {
									setDraft(saved)
									setEditing(true)
								}}
							>
								Edit
							</Button>
						</ViewerTooltip>
					)
				}
			/>
			<p className="px-1 text-[13px] text-muted-foreground">
				Agents read this when {firstName} is @mentioned in a comment.
			</p>
			{editing ? (
				<div className="flex flex-col gap-2.5">
					<Textarea
						aria-label={`What agents know about ${firstName}`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						className="min-h-[160px] font-mono text-sm"
						autoFocus
					/>
					<div className="flex justify-end gap-2">
						<Button
							variant="ghost"
							className={PILL_BUTTON}
							onClick={() => setEditing(false)}
							disabled={updateActor.isPending}
						>
							Cancel
						</Button>
						<Button className={PILL_BUTTON} onClick={save} disabled={updateActor.isPending}>
							{updateActor.isPending ? 'Saving…' : 'Save'}
						</Button>
					</div>
				</div>
			) : (
				<div className="rounded-xl border border-border bg-background px-4 py-3.5 text-[15px] leading-normal text-foreground">
					{saved.trim() ? (
						<p className="whitespace-pre-wrap">{saved.trim()}</p>
					) : (
						<span className="italic text-muted-foreground">
							Nothing yet. Add what agents should know before they bring something to {firstName}.
						</span>
					)}
				</div>
			)}
		</section>
	)
}
