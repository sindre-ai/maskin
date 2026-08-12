import { HumanDetailDialog } from '@/components/settings/human-detail-dialog'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import {
	useAddWorkspaceMember,
	useRemoveWorkspaceMember,
	useUpdateWorkspaceMemberRole,
	useWorkspaceMembers,
} from '@/hooks/use-workspaces'
import type { MemberResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Bot, Plus, Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/members')({
	component: MembersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const ROLE_OPTIONS = ['owner', 'admin', 'member'] as const

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
			setAddError(err instanceof Error ? err.message : 'Failed to add member')
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

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between space-y-0">
				<CardTitle>Members</CardTitle>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="outline" size="sm">
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
			</CardHeader>
			<CardContent>
				{roleError && (
					<p className="mb-3 text-sm text-error" role="alert">
						{roleError}
					</p>
				)}
				{isLoading ? (
					<ListSkeleton />
				) : !members?.length ? (
					<EmptyState title="No members" />
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Member</TableHead>
								<TableHead>Type</TableHead>
								<TableHead className="w-40">Role</TableHead>
								<TableHead className="w-16 text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{members.map((member) => (
								<TableRow key={member.actorId}>
									<TableCell>
										<button
											type="button"
											className="flex items-center gap-3 text-left transition-colors hover:text-foreground"
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
											<span className="text-sm font-medium">{member.name}</span>
										</button>
									</TableCell>
									<TableCell className="text-sm text-muted-foreground">{member.type}</TableCell>
									<TableCell>
										<Select
											value={member.role}
											onValueChange={(value) => handleRoleChange(member, value)}
										>
											<SelectTrigger aria-label={`Role for ${member.name}`}>
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
									</TableCell>
									<TableCell className="text-right">
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Remove ${member.name}`}
											onClick={() => {
												setRemoveError(null)
												setPendingRemoval(member)
											}}
										>
											<Trash2 size={14} />
										</Button>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>

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
							<SelectTrigger>
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
						{addError && (
							<p className="text-sm text-error" role="alert">
								{addError}
							</p>
						)}
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
		</Card>
	)
}
