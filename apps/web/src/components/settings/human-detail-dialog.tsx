import { ActorAvatar } from '@/components/shared/actor-avatar'
import { FormError } from '@/components/shared/form-error'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useActor, useUpdateActor } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import {
	useRemoveWorkspaceMember,
	useUpdateWorkspaceMemberRole,
	useWorkspaceMembers,
} from '@/hooks/use-workspaces'
import { ApiError } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { VIEWER_READ_ONLY_MESSAGE } from '@/lib/workspace-role'
import { useEffect, useState } from 'react'

interface HumanDetailDialogProps {
	actorId: string | null
	workspaceId: string
	open: boolean
	onOpenChange: (open: boolean) => void
}

// 'owner' is intentionally absent: billing ownership moves through
// POST /workspaces/:id/transfer-ownership, which enforces the plan's ownership
// cap. The API rejects role='owner' here, so offering it would only ever 400.
const ROLE_OPTIONS = ['admin', 'member'] as const

export function HumanDetailDialog({
	actorId,
	workspaceId,
	open,
	onOpenChange,
}: HumanDetailDialogProps) {
	const { data: actor } = useActor(actorId ?? '')
	const updateActor = useUpdateActor(workspaceId)
	const removeMember = useRemoveWorkspaceMember(workspaceId)
	const updateRole = useUpdateWorkspaceMemberRole(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const member = members?.find((m) => m.actorId === actorId)
	const { workspace } = useWorkspace()
	const canWrite = useCanWrite()

	const [descriptionDraft, setDescriptionDraft] = useState('')
	const [systemPromptDraft, setSystemPromptDraft] = useState('')
	const [confirmingRemove, setConfirmingRemove] = useState(false)
	const [roleError, setRoleError] = useState<string | null>(null)

	useEffect(() => {
		setDescriptionDraft(actor?.description ?? '')
		setSystemPromptDraft(actor?.system_prompt ?? '')
	}, [actor?.description, actor?.system_prompt])

	useEffect(() => {
		if (!open) {
			setConfirmingRemove(false)
			setRoleError(null)
			removeMember.reset()
		}
	}, [open, removeMember.reset])

	if (!actorId) return null

	const handleRoleChange = async (nextRole: string) => {
		if (!member || !canWrite || nextRole === member.role) return
		setRoleError(null)
		try {
			await updateRole.mutateAsync({ actorId: member.actorId, role: nextRole })
		} catch (err) {
			setRoleError(err instanceof Error ? err.message : 'Failed to update role')
		}
	}

	const handleSave = () => {
		if (!actor || !canWrite) return
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

	// A viewer may still leave on their own; removing someone else is a write.
	const leaveButton = (
		<Button
			type="button"
			variant="ghost"
			className="text-error hover:text-error"
			disabled={isBillingOwner || (!canWrite && !isSelf)}
			onClick={() => setConfirmingRemove(true)}
		>
			{removeLabel}
		</Button>
	)

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
					{member && member.role !== 'owner' && (
						<div>
							<Label htmlFor="human-role">Role</Label>
							<ViewerTooltip className="flex w-full">
								<Select
									value={member.role}
									onValueChange={handleRoleChange}
									disabled={updateRole.isPending || !canWrite}
								>
									<SelectTrigger
										id="human-role"
										aria-label={`Role for ${member.name}`}
										className="w-full"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{ROLE_OPTIONS.map((role) => (
											<SelectItem key={role} value={role}>
												{role}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</ViewerTooltip>
							{roleError && (
								<p className="mt-1 text-sm text-error" role="alert">
									{roleError}
								</p>
							)}
						</div>
					)}
					<div>
						<Label htmlFor="human-description">Description</Label>
						<Input
							id="human-description"
							type="text"
							value={descriptionDraft}
							onChange={(e) => setDescriptionDraft(e.target.value)}
							placeholder={canWrite ? 'Short one-liner (max 80 chars)' : VIEWER_READ_ONLY_MESSAGE}
							maxLength={80}
							disabled={!canWrite}
						/>
					</div>
					<div>
						<Label htmlFor="human-system-prompt">System prompt</Label>
						<Textarea
							id="human-system-prompt"
							value={systemPromptDraft}
							onChange={(e) => setSystemPromptDraft(e.target.value)}
							placeholder={
								canWrite
									? 'Context for agents when this person is @mentioned in a comment.'
									: VIEWER_READ_ONLY_MESSAGE
							}
							className="min-h-[160px] font-mono text-sm"
							disabled={!canWrite}
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
					{isSelf ? leaveButton : <ViewerTooltip>{leaveButton}</ViewerTooltip>}
					<div className="flex gap-2">
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<ViewerTooltip>
							<Button
								type="button"
								onClick={handleSave}
								disabled={updateActor.isPending || !canWrite}
							>
								{updateActor.isPending ? 'Saving…' : 'Save'}
							</Button>
						</ViewerTooltip>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}
