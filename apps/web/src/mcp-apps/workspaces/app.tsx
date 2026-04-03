import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { useToolResult } from '../shared/mcp-app-provider'
import { renderMcpApp } from '../shared/render'
import type { MemberResponse, WorkspaceResponse } from '../shared/types'

function WorkspacesApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = JSON.parse(text)

	switch (toolResult.toolName) {
		case 'list_workspaces':
			return <WorkspaceListView workspaces={data.data ?? data} />
		case 'list_workspace_members':
			return <MemberListView members={data.data ?? data} />
		case 'add_workspace_member':
			return <MemberAddedView member={data} />
		case 'create_workspace':
		case 'update_workspace':
			return <WorkspaceDetailView workspace={data} />
		default:
			return <WorkspaceDetailView workspace={data} />
	}
}

function WorkspaceListView({ workspaces }: { workspaces: WorkspaceResponse[] }) {
	if (!workspaces.length) {
		return <EmptyState title="No workspaces" description="No workspaces found" />
	}

	return (
		<div className="p-4 space-y-1">
			{workspaces.map((ws) => (
				<div
					key={ws.id}
					className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors"
				>
					<span className="text-sm text-foreground flex-1">{ws.name}</span>
					{ws.createdAt && (
						<RelativeTime date={ws.createdAt} className="text-xs text-muted-foreground" />
					)}
				</div>
			))}
		</div>
	)
}

function WorkspaceDetailView({ workspace }: { workspace: WorkspaceResponse }) {
	return (
		<div className="p-4 max-w-2xl">
			<h1 className="text-xl font-semibold text-foreground mb-2">{workspace.name}</h1>
			<div className="text-xs text-muted-foreground mb-4">ID: {workspace.id}</div>
			{workspace.settings && Object.keys(workspace.settings).length > 0 && (
				<div className="border-t border-border pt-3">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Settings
					</h3>
					<pre className="text-xs text-muted-foreground bg-card rounded p-3 overflow-auto">
						{JSON.stringify(workspace.settings, null, 2)}
					</pre>
				</div>
			)}
		</div>
	)
}

function MemberListView({ members }: { members: MemberResponse[] }) {
	if (!members.length) {
		return <EmptyState title="No members" description="This workspace has no members" />
	}

	return (
		<div className="p-4 space-y-1">
			{members.map((member) => (
				<div
					key={member.actorId}
					className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors"
				>
					<ActorAvatar name={member.name} type={member.type} size="sm" />
					<span className="text-sm text-foreground flex-1">{member.name}</span>
					<span className="text-xs text-muted-foreground capitalize">{member.role}</span>
				</div>
			))}
		</div>
	)
}

function MemberAddedView({ member }: { member: MemberResponse }) {
	return (
		<div className="p-4 text-center">
			<p className="text-sm text-muted-foreground">
				<span className="font-medium text-foreground">{member.name}</span> added as{' '}
				<span className="capitalize">{member.role}</span>
			</p>
		</div>
	)
}

renderMcpApp('Workspaces', <WorkspacesApp />)
