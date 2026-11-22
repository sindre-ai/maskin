import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { useCanWrite } from '@/hooks/use-can-write'
import { useRemoveWorkspaceMember, useUpdateWorkspaceMemberRole } from '@/hooks/use-workspaces'
import { ApiError, type MemberResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'

// 'owner' is intentionally absent: billing ownership moves through
// POST /workspaces/:id/transfer-ownership, which enforces the plan's ownership
// cap. The API rejects role='owner' here, so offering it would only ever 400.
const ROLE_OPTIONS = ['admin', 'member'] as const

/** Role change and remove / leave, moved over from the old member pop-up unchanged. */
export function PersonAccess({
	member,
	name,
	firstName,
	isSelf,
}: {
	member: MemberResponse
	name: string
	firstName: string
	isSelf: boolean
}) {
	const { workspaceId, workspace } = useWorkspace()
	const canWrite = useCanWrite()
	const navigate = useNavigate()
	const updateRole = useUpdateWorkspaceMemberRole(workspaceId)
	const removeMember = useRemoveWorkspaceMember(workspaceId)
	const [roleError, setRoleError] = useState<string | null>(null)
	const [confirming, setConfirming] = useState(false)
	const keepRef = useRef<HTMLButtonElement>(null)

	const isBillingOwner = workspace.billingOwnerId === member.actorId
	const removeLabel = isSelf ? 'Leave workspace' : 'Remove from workspace'
	const showRole = member.role !== 'owner' && !isSelf

	const handleRoleChange = async (nextRole: string) => {
		if (!canWrite || nextRole === member.role) return
		setRoleError(null)
		try {
			await updateRole.mutateAsync({ actorId: member.actorId, role: nextRole })
		} catch (err) {
			setRoleError(err instanceof Error ? err.message : 'Failed to update role')
		}
	}

	const handleRemove = () =>
		removeMember.mutate(member.actorId, {
			onSuccess: () => navigate({ to: '/$workspaceId/settings/members', params: { workspaceId } }),
		})

	const removeError =
		removeMember.error instanceof ApiError && removeMember.error.code === 'CONFLICT'
			? 'This person is the billing owner. Transfer ownership to another member before removing them.'
			: removeMember.error?.message

	const note = isBillingOwner
		? `${isSelf ? "You're" : `${name} is`} the billing owner for this workspace. Transfer ownership to another member before ${isSelf ? 'leaving' : 'removing them'}.`
		: isSelf
			? "You'll lose access to this workspace immediately."
			: `${firstName} will lose access to this workspace immediately.`

	// A viewer may still leave on their own; removing someone else is a write.
	const removeButton = (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className={cn('text-error hover:text-error')}
			disabled={isBillingOwner || (!canWrite && !isSelf)}
			onClick={() => {
				setConfirming(true)
				// The button it replaces unmounts, so focus would fall to the page.
				requestAnimationFrame(() => keepRef.current?.focus())
			}}
		>
			{removeLabel}
		</Button>
	)

	return (
		<section aria-labelledby="person-access-heading" className="flex flex-col gap-3">
			<AgentSectionHeading id="person-access-heading" title="Access" />
			{showRole && (
				<div className="flex flex-col gap-1.5 px-1">
					<Label htmlFor="person-role">Role in this workspace</Label>
					<ViewerTooltip className="flex w-full sm:w-60">
						<Select
							value={member.role}
							onValueChange={handleRoleChange}
							disabled={updateRole.isPending || !canWrite}
						>
							<SelectTrigger
								id="person-role"
								aria-label={`Role for ${member.name}`}
								className="w-full sm:w-60"
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
						<p className="text-sm text-error" role="alert">
							{roleError}
						</p>
					)}
				</div>
			)}
			<div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
				<p className="text-[15px] text-muted-foreground">{note}</p>
				{confirming ? (
					<div className="flex shrink-0 items-center gap-2">
						<Button
							variant="destructive"
							size="sm"
							onClick={handleRemove}
							disabled={removeMember.isPending}
						>
							{removeMember.isPending ? (
								<>
									<Spinner className="h-3 w-3" />
									Removing…
								</>
							) : (
								'Remove'
							)}
						</Button>
						<Button
							ref={keepRef}
							variant="ghost"
							size="sm"
							onClick={() => {
								setConfirming(false)
								removeMember.reset()
							}}
							disabled={removeMember.isPending}
						>
							Keep
						</Button>
					</div>
				) : isSelf ? (
					removeButton
				) : (
					<ViewerTooltip>{removeButton}</ViewerTooltip>
				)}
			</div>
			{confirming && removeError && (
				<p className="px-1 text-sm text-error" role="alert">
					{removeError}
				</p>
			)}
		</section>
	)
}
