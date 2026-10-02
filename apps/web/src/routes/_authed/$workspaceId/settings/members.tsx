import { HumanDetailDialog } from '@/components/settings/human-detail-dialog'
import { InviteMemberDialog } from '@/components/settings/invite-member-dialog'
import { PendingInviteRow } from '@/components/settings/pending-invite-row'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useResendInvite, useRevokeInvite, useWorkspaceInvites } from '@/hooks/use-invites'
import {
	useRemoveWorkspaceMember,
	useUpdateWorkspaceMemberRole,
	useWorkspaceMembers,
} from '@/hooks/use-workspaces'
import type { MemberResponse, PendingInviteListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Bot, Plus, Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/settings/members')({
	component: MembersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

// Deliberately excludes 'owner'. The backend body schema is
// z.enum(['admin','member']) — ownership is claimed through
// POST /{id}/transfer-ownership, which enforces the plan's ownership cap.
const ROLE_OPTIONS = ['admin', 'member'] as const

function MembersPage() {
	const { workspaceId, workspace } = useWorkspace()
	const { data: members, isLoading } = useWorkspaceMembers(workspaceId)
	const { data: pendingInvites } = useWorkspaceInvites(workspaceId)
	const resendInvite = useResendInvite(workspaceId)
	const revokeInvite = useRevokeInvite(workspaceId)
	const updateRole = useUpdateWorkspaceMemberRole(workspaceId)
	const removeMember = useRemoveWorkspaceMember(workspaceId)
	const navigate = useNavigate()
	const [showInviteDialog, setShowInviteDialog] = useState(false)
	const [activeHumanId, setActiveHumanId] = useState<string | null>(null)
	const [pendingRemoval, setPendingRemoval] = useState<MemberResponse | null>(null)
	const [removeError, setRemoveError] = useState<string | null>(null)
	const [roleError, setRoleError] = useState<string | null>(null)
	const [pendingRevoke, setPendingRevoke] = useState<PendingInviteListItem | null>(null)
	const [revokeError, setRevokeError] = useState<string | null>(null)

	const handleResend = async (invite: PendingInviteListItem) => {
		try {
			await resendInvite.mutateAsync(invite.id)
			toast.success(`Invite re-sent to ${invite.email}.`)
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to resend invite')
		}
	}

	const handleRevoke = async () => {
		if (!pendingRevoke) return
		setRevokeError(null)
		try {
			await revokeInvite.mutateAsync(pendingRevoke.id)
			setPendingRevoke(null)
		} catch (err) {
			setRevokeError(err instanceof Error ? err.message : 'Failed to revoke invite')
		}
	}

	const handleCreateAgent = () => {
		navigate({
			to: '/$workspaceId/agents/$agentId',
			params: { workspaceId, agentId: crypto.randomUUID() },
		})
	}

	const handleRoleChange = async (member: MemberResponse, nextRole: string) => {
		if (nextRole === member.role) return
		setRoleError(null)
		try {
			await updateRole.mutateAsync({ actorId: member.actorId, role: nextRole })
		} catch (err) {
			setRoleError(err instanceof Error ? err.message : 'Failed to update role')
		}
	}

	const handleRemove = async () => {
		if (!pendingRemoval) return
		setRemoveError(null)
		try {
			await removeMember.mutateAsync(pendingRemoval.actorId)
			setPendingRemoval(null)
		} catch (err) {
			setRemoveError(err instanceof Error ? err.message : 'Failed to remove member')
		}
	}

	const count = members?.length ?? 0

	return (
		<div className="max-w-[580px]">
			<div className="mb-3 flex items-center gap-2">
				<h2 className="text-sm font-bold text-foreground">Members</h2>
				<span className="text-xs text-muted-foreground">
					{count} {count === 1 ? 'person or agent' : 'people & agents'}
				</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline" size="sm" className="ml-auto">
							<Plus size={14} className="mr-1" />
							Add member
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onClick={() => setShowInviteDialog(true)}>
							<UserPlus size={14} className="mr-2" />
							Invite member
						</DropdownMenuItem>
						<DropdownMenuItem onClick={handleCreateAgent}>
							<Bot size={14} className="mr-2" />
							Create agent
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{roleError && (
				<p className="mb-3 text-sm text-error" role="alert">
					{roleError}
				</p>
			)}

			{isLoading ? (
				<ListSkeleton />
			) : !members?.length ? (
				<EmptyState
					title="No members"
					description="Invite a teammate or create an agent to get started."
				/>
			) : (
				<div className="flex flex-col">
					{members.map((member) => {
						const isOwner = member.role === 'owner'
						return (
							<div
								key={member.actorId}
								className="flex items-center gap-3 rounded-lg border-b border-border px-2 py-2.5 transition-colors hover:bg-muted"
							>
								<button
									type="button"
									className="flex min-w-0 flex-1 items-center gap-3 text-left"
									onClick={() => {
										if (member.type === 'agent') {
											navigate({
												to: '/$workspaceId/agents/$agentId',
												params: { workspaceId, agentId: member.actorId },
											})
										} else {
											setActiveHumanId(member.actorId)
										}
									}}
								>
									<ActorAvatar name={member.name} type={member.type} size="md" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm font-medium">{member.name}</span>
										<span className="block truncate text-xs capitalize text-muted-foreground">
											{member.type}
										</span>
									</span>
								</button>
								{isOwner ? (
									// The owner's role is not editable here, and `ROLE_OPTIONS` deliberately
									// excludes 'owner', so a Select would render a blank trigger with no
									// matching item. Both mutations are backend-400s for this row anyway
									// (role change wants transfer-ownership; removal wants the billing
									// owner moved first), so render the role and drop the remove control
									// rather than offer two buttons that can only fail.
									<span className="w-28 shrink-0 px-3 text-xs text-muted-foreground">
										{member.role}
									</span>
								) : (
									<Select
										value={member.role}
										onValueChange={(value) => handleRoleChange(member, value)}
										disabled={updateRole.isPending}
									>
										<SelectTrigger className="w-28 shrink-0" aria-label={`Role for ${member.name}`}>
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
								)}
								<Button
									variant="ghost"
									size="icon"
									className={cn('shrink-0', isOwner && 'invisible')}
									aria-label={`Remove ${member.name}`}
									disabled={isOwner}
									onClick={() => {
										setRemoveError(null)
										setPendingRemoval(member)
									}}
								>
									<Trash2 size={14} />
								</Button>
							</div>
						)
					})}
				</div>
			)}

			{!!pendingInvites?.length && (
				<section className="mt-6" aria-label="Pending invites">
					<h3 className="mb-1 px-2 text-xs font-medium text-muted-foreground">
						Pending — {pendingInvites.length}
					</h3>
					<div className="flex flex-col">
						{pendingInvites.map((invite) => (
							<PendingInviteRow
								key={invite.id}
								invite={invite}
								onResend={handleResend}
								onRevoke={(i) => {
									setRevokeError(null)
									setPendingRevoke(i)
								}}
								resending={resendInvite.isPending && resendInvite.variables === invite.id}
							/>
						))}
					</div>
				</section>
			)}

			<InviteMemberDialog
				open={showInviteDialog}
				onOpenChange={setShowInviteDialog}
				workspaceId={workspaceId}
				workspaceName={workspace.name}
			/>

			<Dialog
				open={!!pendingRemoval}
				onOpenChange={(open) => {
					if (!open) {
						setPendingRemoval(null)
						setRemoveError(null)
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Remove member</DialogTitle>
						<DialogDescription>
							Remove {pendingRemoval?.name} from this workspace? They will lose access immediately.
						</DialogDescription>
					</DialogHeader>
					{removeError && (
						<p className="text-sm text-error" role="alert">
							{removeError}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPendingRemoval(null)}>
							Cancel
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={handleRemove}
							disabled={removeMember.isPending}
						>
							Remove
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={!!pendingRevoke}
				onOpenChange={(open) => {
					if (!open) {
						setPendingRevoke(null)
						setRevokeError(null)
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Revoke this invite?</DialogTitle>
						<DialogDescription>
							The link sent to {pendingRevoke?.email} will stop working. You can invite them again
							later.
						</DialogDescription>
					</DialogHeader>
					{revokeError && (
						<p className="text-sm text-error" role="alert">
							{revokeError}
						</p>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPendingRevoke(null)}>
							Keep invite
						</Button>
						<Button
							type="button"
							variant="destructive"
							onClick={handleRevoke}
							disabled={revokeInvite.isPending}
						>
							Revoke
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{activeHumanId && (
				<HumanDetailDialog
					actorId={activeHumanId}
					workspaceId={workspaceId}
					open
					onOpenChange={(open) => {
						if (!open) setActiveHumanId(null)
					}}
				/>
			)}
		</div>
	)
}
