import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { useToolResult } from '../shared/mcp-app-provider'
import { renderMcpApp } from '../shared/render'
import type { MemberResponse, WorkspaceResponse } from '../shared/types'

interface TypeSchema {
	display_name: string
	statuses: string[]
	fields: Array<{ name: string; type: string; required?: boolean; values?: string[] }>
}

interface WorkspaceSchema {
	workspace_id: string
	workspace_name: string
	relationship_types: string[]
	types: Record<string, TypeSchema>
}

interface ExtensionObjectType {
	type: string
	display_name: string
	statuses: string[]
	fields: Array<{ name: string; type: string; required?: boolean; values?: string[] }>
	relationship_types?: string[]
}

interface Extension {
	id: string
	name: string
	enabled: boolean
	object_types: ExtensionObjectType[]
}

function tryParseJson(text: string): { parsed: true; data: unknown } | { parsed: false } {
	try {
		const data = JSON.parse(text)
		if (typeof data === 'object' && data !== null) return { parsed: true, data }
		return { parsed: false }
	} catch {
		return { parsed: false }
	}
}

function WorkspacesApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	switch (toolResult.toolName) {
		case 'list_workspaces': {
			const data = JSON.parse(text)
			return <WorkspaceListView workspaces={data.data ?? data} />
		}
		case 'list_workspace_members': {
			const data = JSON.parse(text)
			return <MemberListView members={data.data ?? data} />
		}
		case 'add_workspace_member': {
			const data = JSON.parse(text)
			return <MemberAddedView member={data} />
		}
		case 'get_workspace_schema': {
			const data = JSON.parse(text) as WorkspaceSchema
			return <WorkspaceSchemaView schema={data} />
		}
		case 'list_extensions': {
			const data = JSON.parse(text) as Extension[]
			return <ExtensionListView extensions={data} />
		}
		case 'create_extension':
		case 'update_extension': {
			const result = tryParseJson(text)
			if (!result.parsed) return <MessageView message={text} />
			return (
				<ExtensionConfirmView
					data={result.data as WorkspaceResponse}
					action={toolResult.toolName === 'create_extension' ? 'created' : 'updated'}
				/>
			)
		}
		case 'delete_extension': {
			const result = tryParseJson(text)
			if (!result.parsed) return <MessageView message={text} />
			return <MessageView message="Extension deleted successfully." />
		}
		case 'create_workspace':
		case 'update_workspace': {
			const data = JSON.parse(text)
			return <WorkspaceDetailView workspace={data} />
		}
		default: {
			const result = tryParseJson(text)
			if (!result.parsed) return <MessageView message={text} />
			return <WorkspaceDetailView workspace={result.data as WorkspaceResponse} />
		}
	}
}

function MessageView({ message }: { message: string }) {
	return (
		<div className="p-4">
			<p className="text-sm text-foreground">{message}</p>
		</div>
	)
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
				<SettingsView settings={workspace.settings as Record<string, unknown>} />
			)}
		</div>
	)
}

function SettingsView({ settings }: { settings: Record<string, unknown> }) {
	const statuses = settings.statuses as Record<string, string[]> | undefined
	const displayNames = settings.display_names as Record<string, string> | undefined
	const fieldDefs = settings.field_definitions as
		| Record<string, Array<{ name: string; type: string; required?: boolean }>>
		| undefined
	const relTypes = settings.relationship_types as string[] | undefined

	const hasStructuredData = statuses || displayNames || fieldDefs || relTypes

	if (!hasStructuredData) {
		return (
			<div className="border-t border-border pt-3">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
					Settings
				</h3>
				<KeyValueList data={settings} />
			</div>
		)
	}

	return (
		<div className="space-y-4">
			{statuses && Object.keys(statuses).length > 0 && (
				<div className="border-t border-border pt-3">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Object Types
					</h3>
					<div className="space-y-3">
						{Object.entries(statuses).map(([type, statusList]) => (
							<div key={type} className="px-3 py-2 rounded-lg bg-muted">
								<div className="flex items-center gap-2 mb-1.5">
									<span className="text-sm font-medium text-foreground">
										{displayNames?.[type] ?? type}
									</span>
									<span className="text-xs text-muted-foreground font-mono">{type}</span>
								</div>
								<div className="flex flex-wrap gap-1">
									{statusList.map((s) => (
										<StatusBadge key={s} status={s} />
									))}
								</div>
								{fieldDefs?.[type] && fieldDefs[type].length > 0 && (
									<div className="mt-2 pt-2 border-t border-border">
										<span className="text-xs text-muted-foreground">Fields: </span>
										{fieldDefs[type].map((f, i) => (
											<span key={f.name} className="text-xs text-foreground">
												{i > 0 && ', '}
												{f.name}
												<span className="text-muted-foreground"> ({f.type})</span>
												{f.required && <span className="text-destructive">*</span>}
											</span>
										))}
									</div>
								)}
							</div>
						))}
					</div>
				</div>
			)}
			{relTypes && relTypes.length > 0 && (
				<div className="border-t border-border pt-3">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Relationship Types
					</h3>
					<div className="flex flex-wrap gap-1">
						{relTypes.map((rt) => (
							<span key={rt} className="px-2 py-0.5 text-xs rounded bg-muted text-foreground">
								{rt.replace(/_/g, ' ')}
							</span>
						))}
					</div>
				</div>
			)}
		</div>
	)
}

function WorkspaceSchemaView({ schema }: { schema: WorkspaceSchema }) {
	const types = Object.entries(schema.types)

	return (
		<div className="p-4 max-w-2xl">
			<h1 className="text-xl font-semibold text-foreground mb-1">{schema.workspace_name}</h1>
			<div className="text-xs text-muted-foreground mb-4">Schema</div>

			{types.length > 0 && (
				<div className="space-y-3 mb-4">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
						Object Types
					</h3>
					{types.map(([type, typeSchema]) => (
						<div key={type} className="px-3 py-2 rounded-lg bg-muted">
							<div className="flex items-center gap-2 mb-1.5">
								<span className="text-sm font-medium text-foreground">
									{typeSchema.display_name}
								</span>
								<span className="text-xs text-muted-foreground font-mono">{type}</span>
							</div>
							{typeSchema.statuses.length > 0 && (
								<div className="flex flex-wrap gap-1 mb-1">
									{typeSchema.statuses.map((s) => (
										<StatusBadge key={s} status={s} />
									))}
								</div>
							)}
							{typeSchema.fields.length > 0 && (
								<div className="mt-2 pt-2 border-t border-border">
									<span className="text-xs text-muted-foreground">Fields: </span>
									{typeSchema.fields.map((f, i) => (
										<span key={f.name} className="text-xs text-foreground">
											{i > 0 && ', '}
											{f.name}
											<span className="text-muted-foreground"> ({f.type})</span>
											{f.required && <span className="text-destructive">*</span>}
										</span>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			)}

			{schema.relationship_types.length > 0 && (
				<div className="border-t border-border pt-3">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
						Relationship Types
					</h3>
					<div className="flex flex-wrap gap-1">
						{schema.relationship_types.map((rt) => (
							<span key={rt} className="px-2 py-0.5 text-xs rounded bg-muted text-foreground">
								{rt.replace(/_/g, ' ')}
							</span>
						))}
					</div>
				</div>
			)}
		</div>
	)
}

function ExtensionListView({ extensions }: { extensions: Extension[] }) {
	if (!extensions.length) {
		return <EmptyState title="No extensions" description="No extensions installed" />
	}

	return (
		<div className="p-4 space-y-1">
			{extensions.map((ext) => (
				<div
					key={ext.id}
					className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors"
				>
					<span
						className={`w-2 h-2 rounded-full ${ext.enabled ? 'bg-success' : 'bg-muted-foreground'}`}
					/>
					<span className="text-sm text-foreground flex-1">{ext.name}</span>
					<span className="text-xs text-muted-foreground">
						{ext.object_types.length} type{ext.object_types.length !== 1 ? 's' : ''}
					</span>
				</div>
			))}
		</div>
	)
}

function ExtensionConfirmView({ data, action }: { data: WorkspaceResponse; action: string }) {
	return (
		<div className="p-4 max-w-2xl">
			<h2 className="text-sm font-medium text-foreground mb-3 capitalize">Extension {action}</h2>
			<WorkspaceDetailView workspace={data} />
		</div>
	)
}

function KeyValueList({ data }: { data: Record<string, unknown> }) {
	return (
		<div className="space-y-1">
			{Object.entries(data).map(([key, value]) => (
				<div key={key} className="flex gap-2 text-xs">
					<span className="text-muted-foreground font-medium min-w-[80px]">
						{key.replace(/_/g, ' ')}
					</span>
					<span className="text-foreground">
						{typeof value === 'object' && value !== null
							? Array.isArray(value)
								? value.join(', ')
								: JSON.stringify(value)
							: String(value)}
					</span>
				</div>
			))}
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
