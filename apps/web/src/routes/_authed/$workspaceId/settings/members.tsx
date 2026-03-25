import { PageHeader } from '@/components/layout/page-header'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
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
import { createFileRoute, useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/members')({
	component: MembersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		create: search.create === 'true' || search.create === true,
	}),
})

function MembersPage() {
	const { workspaceId } = useWorkspace()
	const { data: members, isLoading } = useWorkspaceMembers(workspaceId)
	const addMember = useAddWorkspaceMember(workspaceId)
	const { create } = useSearch({ from: '/_authed/$workspaceId/settings/members' })
	const [showAdd, setShowAdd] = useState(false)

	useEffect(() => {
		if (create) setShowAdd(true)
	}, [create])
	const [actorId, setActorId] = useState('')
	const [role, setRole] = useState('member')

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!actorId.trim()) return
		await addMember.mutateAsync({ actor_id: actorId.trim(), role })
		setActorId('')
		setShowAdd(false)
	}

	return (
		<div>
			<PageHeader title="Members" />

			{showAdd && (
				<form
					onSubmit={handleAdd}
					className="mb-6 flex gap-2 rounded-lg border border-border bg-card p-4"
				>
					<Input
						type="text"
						value={actorId}
						onChange={(e) => setActorId(e.target.value)}
						placeholder="Actor ID (UUID)"
						className="flex-1 font-mono"
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
					<Button type="submit" disabled={addMember.isPending}>
						Add
					</Button>
					<Button type="button" variant="ghost" onClick={() => setShowAdd(false)}>
						Cancel
					</Button>
				</form>
			)}

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
