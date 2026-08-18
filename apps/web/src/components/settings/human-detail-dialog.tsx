import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
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
import { Textarea } from '@/components/ui/textarea'
import { useActor, useUpdateActor } from '@/hooks/use-actors'
import { useUpdateWorkspaceMemberRole, useWorkspaceMembers } from '@/hooks/use-workspaces'
import { useEffect, useState } from 'react'

const ROLE_OPTIONS = ['owner', 'admin', 'member'] as const

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
	const { data: members } = useWorkspaceMembers(workspaceId)
	const member = members?.find((m) => m.actorId === actorId)
	const updateActor = useUpdateActor(workspaceId)
	const updateRole = useUpdateWorkspaceMemberRole(workspaceId)

	const [descriptionDraft, setDescriptionDraft] = useState('')
	const [systemPromptDraft, setSystemPromptDraft] = useState('')
	const [roleError, setRoleError] = useState<string | null>(null)

	// biome-ignore lint/correctness/useExhaustiveDependencies: actorId is the reset trigger — drafts and the role error must clear when the dialog switches actors, even though the effect body never reads actorId.
	useEffect(() => {
		setDescriptionDraft(actor?.description ?? '')
		setSystemPromptDraft(actor?.system_prompt ?? '')
		setRoleError(null)
	}, [actorId, actor?.description, actor?.system_prompt])

	if (!actorId) return null

	const handleRoleChange = async (nextRole: string) => {
		if (!member || nextRole === member.role) return
		setRoleError(null)
		try {
			await updateRole.mutateAsync({ actorId: member.actorId, role: nextRole })
		} catch (err) {
			setRoleError(err instanceof Error ? err.message : 'Failed to update role')
		}
	}

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
					{member && (
						<div>
							<Label htmlFor="human-role">Role</Label>
							<Select
								value={member.role}
								onValueChange={handleRoleChange}
								disabled={updateRole.isPending}
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
				</div>
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button type="button" onClick={handleSave} disabled={updateActor.isPending}>
						{updateActor.isPending ? 'Saving…' : 'Save'}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
