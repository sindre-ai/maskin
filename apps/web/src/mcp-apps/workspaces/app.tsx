import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { StatusBadge } from '@/components/shared/status-badge'
import { useToolResult, useWebAppContext } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { MemberResponse, WorkspaceResponse } from '../shared/types'
import { WebAppLink, useWebAppHref } from '../shared/web-app-link'

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

function WorkspacesApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return (
			<div className="p-[var(--space-4)] text-muted-foreground text-sm">Waiting for data...</div>
		)
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text)
		return <div className="p-[var(--space-4)] text-muted-foreground text-sm">No data received</div>

	const data = safeParseJson(text)
	if (!data) return <MessageView message={text} />
	const unwrapped = unwrapEnvelope(data)

	switch (toolResult.toolName) {
		case 'list_workspaces':
			return isArray(unwrapped) ? (
				<WorkspaceListView workspaces={unwrapped as WorkspaceResponse[]} />
			) : (
				<MessageView message={text} />
			)
		case 'list_workspace_members':
			return isArray(unwrapped) ? (
				<MemberListView members={unwrapped as MemberResponse[]} />
			) : (
				<MessageView message={text} />
			)
		case 'add_workspace_member':
			return isObject<MemberResponse>(data, 'actorId') ? (
				<MemberAddedView member={data} />
			) : (
				<MessageView message={text} />
			)
		case 'get_workspace_schema':
			return isObject<WorkspaceSchema>(data, 'types') ? (
				<WorkspaceSchemaView schema={data} />
			) : (
				<MessageView message={text} />
			)
		case 'list_extensions':
			return isArray(data) ? (
				<ExtensionListView extensions={data as Extension[]} />
			) : (
				<MessageView message={text} />
			)
		case 'create_extension':
		case 'update_extension':
			return isObject<Extension>(data, 'id', 'name') ? (
				<ExtensionConfirmView
					data={data}
					action={toolResult.toolName === 'create_extension' ? 'created' : 'updated'}
				/>
			) : (
				<MessageView message={text} />
			)
		case 'delete_extension':
			return <MessageView message="Extension deleted successfully." />
		case 'create_workspace':
		case 'update_workspace':
			return isObject<WorkspaceResponse>(data, 'id', 'name') ? (
				<WorkspaceDetailView workspace={data} />
			) : (
				<MessageView message={text} />
			)
		default:
			return isObject<WorkspaceResponse>(data, 'id', 'name') ? (
				<WorkspaceDetailView workspace={data} />
			) : (
				<MessageView message={text} />
			)
	}
}

function MessageView({ message }: { message: string }) {
	return (
		<div className="p-[var(--space-4)]">
			<p className="text-sm text-foreground">{message}</p>
		</div>
	)
}

function WorkspaceListView({ workspaces }: { workspaces: WorkspaceResponse[] }) {
	if (!workspaces.length) {
		return <EmptyState title="No workspaces" description="No workspaces found" />
	}

	return (
		<div className="p-[var(--space-4)] space-y-[var(--space-1)]">
			{workspaces.map((ws) => (
				<WorkspaceListRow key={ws.id} workspace={ws} />
			))}
		</div>
	)
}

function WorkspaceListRow({ workspace }: { workspace: WorkspaceResponse }) {
	const ctx = useWebAppContext()
	const href = ctx ? `${ctx.baseUrl}/${workspace.id}` : null
	const content = (
		<>
			<span className="text-sm text-foreground flex-1">{workspace.name}</span>
			{workspace.createdAt && (
				<RelativeTime date={workspace.createdAt} className="text-xs text-muted-foreground" />
			)}
		</>
	)
	if (!href)
		return (
			<div className="flex items-center gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] rounded-lg">
				{content}
			</div>
		)
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex items-center gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors no-underline"
		>
			{content}
		</a>
	)
}

function WorkspaceDetailView({ workspace }: { workspace: WorkspaceResponse }) {
	return (
		<div className="p-[var(--space-4)] max-w-2xl">
			<div className="flex items-start justify-between gap-[var(--space-3)] mb-[var(--space-2)]">
				<h1 className="text-xl font-semibold text-foreground">{workspace.name}</h1>
				<WebAppLink target={{ kind: 'workspace' }} />
			</div>
			<div className="text-xs text-muted-foreground mb-[var(--space-4)]">ID: {workspace.id}</div>
			{workspace.settings && Object.keys(workspace.settings).length > 0 && (
				<SettingsView settings={workspace.settings as Record<string, unknown>} />
			)}
		</div>
	)
}

interface FieldDef {
	name: string
	type: string
	required?: boolean
}

function ObjectTypeCard({
	type,
	displayName,
	statuses,
	fields,
}: {
	type: string
	displayName: string
	statuses: string[]
	fields: FieldDef[]
}) {
	return (
		<div className="px-[var(--space-3)] py-[var(--space-2)] rounded-lg bg-muted">
			<div className="flex items-center gap-[var(--space-2)] mb-[6px]">
				<span className="text-sm font-medium text-foreground">{displayName}</span>
				<span className="text-xs text-muted-foreground font-mono">{type}</span>
			</div>
			{statuses.length > 0 && (
				<div className="flex flex-wrap gap-[var(--space-1)] mb-[var(--space-1)]">
					{statuses.map((s) => (
						<StatusBadge key={s} status={s} />
					))}
				</div>
			)}
			{fields.length > 0 && (
				<div className="mt-[var(--space-2)] pt-[var(--space-2)] border-t border-border">
					<span className="text-xs text-muted-foreground">Fields: </span>
					{fields.map((f, i) => (
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
	)
}

function RelationshipTypeList({ types }: { types: string[] }) {
	return (
		<div className="border-t border-border pt-[var(--space-3)]">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-[var(--space-2)]">
				Relationship Types
			</h3>
			<div className="flex flex-wrap gap-[var(--space-1)]">
				{types.map((rt) => (
					<span
						key={rt}
						className="px-[var(--space-2)] py-[2px] text-xs rounded bg-muted text-foreground"
					>
						{rt.replace(/_/g, ' ')}
					</span>
				))}
			</div>
		</div>
	)
}

function SettingsView({ settings }: { settings: Record<string, unknown> }) {
	const statuses = settings.statuses as Record<string, string[]> | undefined
	const displayNames = settings.display_names as Record<string, string> | undefined
	const fieldDefs = settings.field_definitions as Record<string, FieldDef[]> | undefined
	const relTypes = settings.relationship_types as string[] | undefined

	const hasStructuredData = statuses || displayNames || fieldDefs || relTypes

	if (!hasStructuredData) {
		return (
			<div className="border-t border-border pt-[var(--space-3)]">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-[var(--space-2)]">
					Settings
				</h3>
				<KeyValueList data={settings} />
			</div>
		)
	}

	return (
		<div className="space-y-[var(--space-4)]">
			{statuses && Object.keys(statuses).length > 0 && (
				<div className="border-t border-border pt-[var(--space-3)]">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-[var(--space-2)]">
						Object Types
					</h3>
					<div className="space-y-[var(--space-3)]">
						{Object.entries(statuses).map(([type, statusList]) => (
							<ObjectTypeCard
								key={type}
								type={type}
								displayName={displayNames?.[type] ?? type}
								statuses={statusList}
								fields={fieldDefs?.[type] ?? []}
							/>
						))}
					</div>
				</div>
			)}
			{relTypes && relTypes.length > 0 && <RelationshipTypeList types={relTypes} />}
		</div>
	)
}

function WorkspaceSchemaView({ schema }: { schema: WorkspaceSchema }) {
	const types = Object.entries(schema.types)

	return (
		<div className="p-[var(--space-4)] max-w-2xl">
			<h1 className="text-xl font-semibold text-foreground mb-[var(--space-1)]">
				{schema.workspace_name}
			</h1>
			<div className="text-xs text-muted-foreground mb-[var(--space-4)]">Schema</div>

			{types.length > 0 && (
				<div className="space-y-[var(--space-3)] mb-[var(--space-4)]">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
						Object Types
					</h3>
					{types.map(([type, typeSchema]) => (
						<ObjectTypeCard
							key={type}
							type={type}
							displayName={typeSchema.display_name}
							statuses={typeSchema.statuses}
							fields={typeSchema.fields}
						/>
					))}
				</div>
			)}

			{schema.relationship_types.length > 0 && (
				<RelationshipTypeList types={schema.relationship_types} />
			)}
		</div>
	)
}

function ExtensionListView({ extensions }: { extensions: Extension[] }) {
	if (!extensions.length) {
		return <EmptyState title="No extensions" description="No extensions installed" />
	}

	return (
		<div className="p-[var(--space-4)] space-y-[var(--space-1)]">
			{extensions.map((ext) => (
				<ExtensionListRow key={ext.id} ext={ext} />
			))}
		</div>
	)
}

function ExtensionListRow({ ext }: { ext: Extension }) {
	const href = useWebAppHref({ kind: 'settings' })
	const content = (
		<>
			<span
				className={`w-2 h-2 rounded-full ${ext.enabled ? 'bg-success' : 'bg-muted-foreground'}`}
			/>
			<span className="text-sm text-foreground flex-1">{ext.name}</span>
			<span className="text-xs text-muted-foreground">
				{ext.object_types.length} type{ext.object_types.length !== 1 ? 's' : ''}
			</span>
		</>
	)
	if (!href)
		return (
			<div className="flex items-center gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] rounded-lg">
				{content}
			</div>
		)
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex items-center gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors no-underline"
		>
			{content}
		</a>
	)
}

function ExtensionConfirmView({ data, action }: { data: Extension; action: string }) {
	return (
		<div className="p-[var(--space-4)] max-w-2xl">
			<h2 className="text-sm font-medium text-foreground mb-[var(--space-3)] capitalize">
				Extension {action}
			</h2>
			<div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
				<span
					className={`w-2 h-2 rounded-full ${data.enabled ? 'bg-success' : 'bg-muted-foreground'}`}
				/>
				<h3 className="text-lg font-semibold text-foreground">{data.name}</h3>
			</div>
			<div className="text-xs text-muted-foreground mb-[var(--space-4)]">ID: {data.id}</div>
			{data.object_types.length > 0 && (
				<div className="space-y-[var(--space-3)]">
					<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
						Object Types
					</h3>
					{data.object_types.map((ot) => (
						<ObjectTypeCard
							key={ot.type}
							type={ot.type}
							displayName={ot.display_name}
							statuses={ot.statuses}
							fields={ot.fields}
						/>
					))}
				</div>
			)}
		</div>
	)
}

function KeyValueList({ data }: { data: Record<string, unknown> }) {
	return (
		<div className="space-y-[var(--space-1)]">
			{Object.entries(data).map(([key, value]) => (
				<div key={key} className="flex gap-[var(--space-2)] text-xs">
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
		<div className="p-[var(--space-4)] space-y-[var(--space-1)]">
			{members.map((member) => (
				<MemberListRow key={member.actorId} member={member} />
			))}
		</div>
	)
}

function MemberListRow({ member }: { member: MemberResponse }) {
	const href = useWebAppHref({ kind: 'actor', id: member.actorId })
	const content = (
		<>
			<ActorAvatar name={member.name} type={member.type} size="sm" />
			<span className="text-sm text-foreground flex-1">{member.name}</span>
			<span className="text-xs text-muted-foreground capitalize">{member.role}</span>
		</>
	)
	if (!href)
		return (
			<div className="flex items-center gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] rounded-lg">
				{content}
			</div>
		)
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex items-center gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-2)] rounded-lg hover:bg-accent hover:text-accent-foreground transition-colors no-underline"
		>
			{content}
		</a>
	)
}

function MemberAddedView({ member }: { member: MemberResponse }) {
	return (
		<div className="p-[var(--space-4)] text-center">
			<p className="text-sm text-muted-foreground">
				<span className="font-medium text-foreground">{member.name}</span> added as{' '}
				<span className="capitalize">{member.role}</span>
			</p>
		</div>
	)
}

renderMcpApp('Workspaces', <WorkspacesApp />)
