import { HumanDetailDialog } from '@/components/settings/human-detail-dialog'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { FormError } from '@/components/shared/form-error'
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
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import {
	useAddWorkspaceMember,
	useRemoveWorkspaceMember,
	useUpdateWorkspaceMemberRole,
	useWorkspaceMembers,
} from '@/hooks/use-workspaces'
import { ApiError, type MemberResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Bot, Plus, Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/members')({
	component: MembersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

// Deliberately excludes 'owner'. The backend body schema is
// z.enum(['admin','member']) — ownership is claimed through
// POST /{id}/transfer-ownership, which enforces the plan's ownership cap.
const ROLE_OPTIONS = ['admin', 'member'] as const

function MembersPage() {
	const { workspaceId } = useWorkspace()
	const { data: members, isLoading } = useWorkspaceMembers(workspaceId)
	const addMember = useAddWorkspaceMember(workspaceId)
	const updateRole = useUpdateWorkspaceMemberRole(workspaceId)
	const removeMember = useRemoveWorkspaceMember(workspaceId)
	const navigate = useNavigate()
	const [showAddDialog, setShowAddDialog] = useState(false)
	const [actorId, setActorId] = useState('')
	const [newMemberRole, setNewMemberRole] = useState('member')
	const [addError, setAddError] = useState<string | null>(null)
	const [activeHumanId, setActiveHumanId] = useState<string | null>(null)
	const [pendingRemoval, setPendingRemoval] = useState<MemberResponse | null>(null)
	const [removeError, setRemoveError] = useState<string | null>(null)
	const [roleError, setRoleError] = useState<string | null>(null)

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!actorId.trim()) return
		setAddError(null)
		try {
			await addMember.mutateAsync({ actor_id: actorId.trim(), role: newMemberRole })
			setActorId('')
			setNewMemberRole('member')
			setShowAddDialog(false)
		} catch (err) {
			setAddError(
				err instanceof ApiError && err.code === 'SEAT_CAP_EXCEEDED'
					? "This workspace has reached its plan's member limit. Upgrade to add more."
					: err instanceof Error
						? err.message
						: 'Failed to add member',
			)
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
						<DropdownMenuItem onClick={() => setShowAddDialog(true)}>
							<UserPlus size={14} className="mr-2" />
							Add human
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
					{members.map((member) => (
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
							<Button
								variant="ghost"
								size="icon"
								className="shrink-0"
								aria-label={`Remove ${member.name}`}
								onClick={() => {
									setRemoveError(null)
									setPendingRemoval(member)
								}}
							>
								<Trash2 size={14} />
							</Button>
						</div>
					))}
				</div>
			)}

			<Dialog
				open={showAddDialog}
				onOpenChange={(open) => {
					setShowAddDialog(open)
					if (!open) setAddError(null)
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add member</DialogTitle>
						<DialogDescription>
							Invite an existing user to this workspace by their Actor ID.
						</DialogDescription>
					</DialogHeader>
					<form onSubmit={handleAdd} className="space-y-4">
						<Input
							type="text"
							value={actorId}
							onChange={(e) => setActorId(e.target.value)}
							placeholder="Actor ID (UUID)"
							className="font-mono"
							autoFocus
						/>
						<Select value={newMemberRole} onValueChange={setNewMemberRole}>
							<SelectTrigger aria-label="Role for the new member">
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
						{addError && <FormError error={addError} />}
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setShowAddDialog(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!actorId.trim() || addMember.isPending}>
								Add
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>

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
