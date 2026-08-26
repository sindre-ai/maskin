import { ActorAvatar } from '@/components/shared/actor-avatar'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useActor, useUpdateActor } from '@/hooks/use-actors'
import { useRemoveWorkspaceMember } from '@/hooks/use-workspaces'
import { ApiError } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { useEffect, useState } from 'react'

interface HumanDetailDialogProps {
	actorId: string | null
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}

export function HumanDetailDialog({
	actorId,
	workspaceId,
	open,
	onOpenChange,
}: HumanDetailDialogProps) {
	const { data: actor } = useActor(actorId ?? '')
	const updateActor = useUpdateActor(workspaceId)
	const removeMember = useRemoveWorkspaceMember(workspaceId)
	const { workspace } = useWorkspace()

	const [descriptionDraft, setDescriptionDraft] = useState('')
	const [systemPromptDraft, setSystemPromptDraft] = useState('')
	const [confirmingRemove, setConfirmingRemove] = useState(false)

	useEffect(() => {
		setDescriptionDraft(actor?.description ?? '')
		setSystemPromptDraft(actor?.system_prompt ?? '')
	}, [actor?.description, actor?.system_prompt])

	useEffect(() => {
		if (!open) {
			setConfirmingRemove(false)
			removeMember.reset()
		}
	}, [open, removeMember.reset])

	if (!actorId) return null

	const handleSave = () => {
		if (!actor) return
		const description = descriptionDraft.trim()
		const systemPrompt = systemPromptDraft
		const data: { description?: string; system_prompt?: string } = {}
		if (description !== (actor.description ?? '')) data.description = description
		if (systemPrompt !== (actor.system_prompt ?? '')) data.system_prompt = systemPrompt
		if (Object.keys(data).length === 0) {
			onOpenChange(false)
			return
		}
		updateActor.mutate({ id: actor.id, data }, { onSuccess: () => onOpenChange(false) })
	}

	const isSelf = getStoredActor()?.id === actorId
	const isBillingOwner = workspace.billingOwnerId === actorId
	const removeLabel = isSelf ? 'Leave workspace' : 'Remove from workspace'

	const handleRemove = () => {
		removeMember.mutate(actorId, { onSuccess: () => onOpenChange(false) })
	}

	if (confirmingRemove) {
		const errorMessage =
			removeMember.error instanceof ApiError && removeMember.error.code === 'CONFLICT'
				? 'This person is the billing owner — transfer ownership to another member before removing them.'
				: removeMember.error?.message

		return (
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{removeLabel}?</DialogTitle>
						<DialogDescription>
							{isSelf
								? `You'll lose access to this workspace immediately.`
								: `${actor?.name ?? 'This person'} will lose access to this workspace immediately.`}
						</DialogDescription>
					</DialogHeader>
					{errorMessage && <FormError error={errorMessage} />}
					<DialogFooter className="gap-2">
						<Button
							variant="ghost"
							onClick={() => setConfirmingRemove(false)}
							disabled={removeMember.isPending}
						>
							Cancel
						</Button>
						<Button variant="destructive" onClick={handleRemove} disabled={removeMember.isPending}>
							{removeMember.isPending ? (
								<>
									<Spinner className="h-3 w-3" />
									Removing…
								</>
							) : (
								removeLabel
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<ActorAvatar name={actor?.name ?? 'Member'} type="human" size="md" />
						{actor?.name ?? 'Member'}
					</DialogTitle>
					<DialogDescription>
						{actor?.email ??
							'Human teammate. Add context that agents can pick up when you are @mentioned.'}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div>
						<Label htmlFor="human-description">Description</Label>
						<Input
							id="human-description"
							type="text"
							value={descriptionDraft}
							onChange={(e) => setDescriptionDraft(e.target.value)}
							placeholder="Short one-liner (max 80 chars)"
							maxLength={80}
						/>
					</div>
					<div>
						<Label htmlFor="human-system-prompt">System prompt</Label>
						<Textarea
							id="human-system-prompt"
							value={systemPromptDraft}
							onChange={(e) => setSystemPromptDraft(e.target.value)}
							placeholder="Context for agents when this person is @mentioned in a comment."
							className="min-h-[160px] font-mono text-sm"
						/>
						<p className="mt-1 text-xs text-muted-foreground">
							Agents fetch this on demand via the actor API when this person is @mentioned in a
							comment.
						</p>
					</div>
					{isBillingOwner && (
						<p className="text-xs text-muted-foreground">
							{isSelf ? "You're" : `${actor?.name ?? 'This person'} is`} the billing owner for this
							workspace — transfer ownership to another member before{' '}
							{isSelf ? 'leaving' : 'removing them'}.
						</p>
					)}
				</div>
				<div className="flex justify-between gap-2">
					<Button
						type="button"
						variant="ghost"
						className="text-error hover:text-error"
						disabled={isBillingOwner}
						onClick={() => setConfirmingRemove(true)}
					>
						{removeLabel}
					</Button>
					<div className="flex gap-2">
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="button" onClick={handleSave} disabled={updateActor.isPending}>
							{updateActor.isPending ? 'Saving…' : 'Save'}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
