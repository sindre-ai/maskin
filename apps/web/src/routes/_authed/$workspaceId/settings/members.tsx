import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
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
import { useAddWorkspaceMember, useWorkspaceMembers } from '@/hooks/use-workspaces'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Bot, Plus, UserPlus } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/members')({
	component: MembersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function MembersPage() {
	const { workspaceId } = useWorkspace()
	const { data: members, isLoading } = useWorkspaceMembers(workspaceId)
	const addMember = useAddWorkspaceMember(workspaceId)
	const navigate = useNavigate()
	const [showAddDialog, setShowAddDialog] = useState(false)
	const [actorId, setActorId] = useState('')
	const [role, setRole] = useState('member')

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!actorId.trim()) return
		await addMember.mutateAsync({ actor_id: actorId.trim(), role })
		setActorId('')
		setShowAddDialog(false)
	}

	const handleCreateAgent = () => {
		navigate({
			to: '/$workspaceId/agents/$agentId',
			params: { workspaceId, agentId: crypto.randomUUID() },
		})
	}

	return (
		<div>
			<div className="flex justify-end mb-4">
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
			</div>

			<Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
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
						<Select value={role} onValueChange={setRole}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="member">member</SelectItem>
								<SelectItem value="admin">admin</SelectItem>
							</SelectContent>
						</Select>
						<div className="flex justify-end gap-2">
							<Button type="button" variant="ghost" onClick={() => setShowAddDialog(false)}>
								Cancel
							</Button>
							<Button type="submit" disabled={!actorId.trim() || addMember.isPending}>
								Add
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>

			{isLoading ? (
				<ListSkeleton />
			) : !members?.length ? (
				<EmptyState title="No members" />
			) : (
				<div className="space-y-1">
					{members.map((member) => (
						<div key={member.actorId} className="flex items-center gap-3 rounded px-3 py-2">
							<ActorAvatar name={member.name} type={member.type} size="md" />
							<div className="flex-1">
								<p className="text-sm font-medium text-foreground">{member.name}</p>
								<p className="text-xs text-muted-foreground">{member.type}</p>
							</div>
							<span className="text-xs text-muted-foreground">{member.role}</span>
						</div>
					))}
				</div>
			)}
		</div>
	)
}
