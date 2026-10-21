import { ImportMcpDialog } from '@/components/integrations/import-mcp-dialog'
import { ProviderCard } from '@/components/integrations/provider-card'
import { ToolServerAccess } from '@/components/integrations/tool-server-access'
import { ToolServerForm } from '@/components/integrations/tool-server-form'
import { Button } from '@/components/ui/button'
import {
	useCreateCustomMcpServer,
	useCustomMcpServer,
	useIntegrations,
	useRemoveCustomMcpServer,
	useUpdateCustomMcpServer,
} from '@/hooks/use-integrations'
import { ApiError, type CustomMcpServerSpec, type IntegrationResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { AGENT_ACCESS_LABELS } from '@maskin/shared'
import { FileJson, Lock, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

function errorText(err: unknown): string {
	if (err instanceof ApiError) return err.message
	return err instanceof Error ? err.message : 'Something went wrong'
}

/** The non-secret summary the server stores on the row: transport and where it points. */
function describeServer(row: IntegrationResponse): string {
	const summary = (row.config as { custom_mcp?: { transport?: string; target?: string } })
		.custom_mcp
	if (!summary) return 'Custom MCP server'
	return `${summary.transport === 'http' ? 'HTTP' : 'stdio'} · ${summary.target ?? ''}`
}

/**
 * Custom tools: every MCP server the workspace's agents can use that is not a connected integration.
 * Maskin itself is always on, for every agent, and cannot be changed. The rest are added here
 * once and shared with chosen agents (or all of them), instead of being set up agent by agent.
 */
export function ToolsSection({ workspaceId }: { workspaceId: string }) {
	const { workspace } = useWorkspace()
	const { data: integrations } = useIntegrations(workspaceId)
	const create = useCreateCustomMcpServer(workspaceId)
	const [adding, setAdding] = useState(false)
	const [editingId, setEditingId] = useState<string | null>(null)
	const [importOpen, setImportOpen] = useState(false)
	const [importError, setImportError] = useState<string | null>(null)

	const servers = (integrations ?? []).filter(
		(i) => i.provider === 'custom-mcp' && i.status === 'active',
	)
	const me = getStoredActor()
	const isHuman = me?.type === 'human' && workspace.role !== 'viewer'

	const handleCreate = (name: string, server: CustomMcpServerSpec) =>
		create.mutate({ name, server }, { onSuccess: () => setAdding(false) })

	const handleImport = async (imported: Record<string, CustomMcpServerSpec>) => {
		setImportError(null)
		const failed: string[] = []
		for (const [name, server] of Object.entries(imported)) {
			try {
				await create.mutateAsync({ name, server })
			} catch (err) {
				failed.push(`${name}: ${errorText(err)}`)
			}
		}
		if (failed.length === 0) setImportOpen(false)
		else setImportError(failed.join('\n'))
	}

	return (
		<section aria-labelledby="tools-heading" className="mt-8 space-y-2">
			<h2 id="tools-heading" className="settings-label">
				Custom tools
			</h2>

			<ProviderCard
				name="Maskin"
				tone="connected"
				actions={
					<span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
						<Lock className="h-3.5 w-3.5" aria-hidden="true" />
						{AGENT_ACCESS_LABELS.read_write} · always on
					</span>
				}
			/>

			{servers.map((server) =>
				editingId === server.id ? (
					<EditServer
						key={server.id}
						workspaceId={workspaceId}
						row={server}
						onDone={() => setEditingId(null)}
					/>
				) : (
					<ServerRow
						key={server.id}
						row={server}
						workspaceId={workspaceId}
						onEdit={() => setEditingId(server.id)}
					/>
				),
			)}

			{adding && (
				<ToolServerForm
					saving={create.isPending}
					error={create.error ? errorText(create.error) : null}
					onSave={handleCreate}
					onCancel={() => {
						create.reset()
						setAdding(false)
					}}
				/>
			)}

			{isHuman && !adding && (
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<Button size="sm" variant="outline" onClick={() => setAdding(true)}>
						<Plus className="mr-1 h-3.5 w-3.5" />
						Add server
					</Button>
					<Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
						<FileJson className="mr-1 h-3.5 w-3.5" />
						Import .mcp.json
					</Button>
				</div>
			)}

			<ImportMcpDialog
				open={importOpen}
				saving={create.isPending}
				error={importError}
				onClose={() => {
					setImportOpen(false)
					setImportError(null)
				}}
				onImport={handleImport}
			/>
		</section>
	)
}

function ServerRow({
	row,
	workspaceId,
	onEdit,
}: {
	row: IntegrationResponse
	workspaceId: string
	onEdit: () => void
}) {
	const { workspace } = useWorkspace()
	const remove = useRemoveCustomMcpServer(workspaceId)
	const [confirmDelete, setConfirmDelete] = useState(false)
	const me = getStoredActor()
	const canEdit =
		me?.type === 'human' &&
		(row.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')
	const name = row.displayName ?? 'Tool server'

	return (
		<ProviderCard
			name={name}
			subtitle={describeServer(row)}
			tone="connected"
			actions={
				canEdit &&
				(confirmDelete ? (
					<div className="flex shrink-0 items-center gap-1">
						<Button
							size="sm"
							variant="destructive"
							disabled={remove.isPending}
							onClick={() => remove.mutate(row.id)}
						>
							Remove
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
							Cancel
						</Button>
					</div>
				) : (
					<div className="flex shrink-0 items-center gap-1">
						<Button
							size="icon"
							variant="ghost"
							className="text-muted-foreground"
							onClick={onEdit}
							aria-label={`Edit ${name}`}
						>
							<Pencil className="h-3.5 w-3.5" />
						</Button>
						<Button
							size="icon"
							variant="ghost"
							className="text-muted-foreground hover:text-error"
							onClick={() => setConfirmDelete(true)}
							aria-label={`Remove ${name}`}
						>
							<Trash2 className="h-3.5 w-3.5" />
						</Button>
					</div>
				))
			}
			footer={<ToolServerAccess integration={row} workspaceId={workspaceId} />}
		/>
	)
}

function EditServer({
	row,
	workspaceId,
	onDone,
}: {
	row: IntegrationResponse
	workspaceId: string
	onDone: () => void
}) {
	const { data, isLoading, error: loadError } = useCustomMcpServer(workspaceId, row.id)
	const update = useUpdateCustomMcpServer(workspaceId, row.id)

	if (isLoading) {
		return (
			<p className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
				Loading…
			</p>
		)
	}
	if (loadError || !data) {
		return (
			<div className="flex items-center gap-2 rounded-lg border border-border bg-card p-4">
				<p className="flex-1 text-xs text-error">Couldn't load this server.</p>
				<Button size="sm" variant="ghost" onClick={onDone}>
					Close
				</Button>
			</div>
		)
	}
	return (
		<ToolServerForm
			initialName={data.name}
			initialServer={data.server}
			saving={update.isPending}
			error={update.error ? errorText(update.error) : null}
			onSave={(name, server) => update.mutate({ name, server }, { onSuccess: onDone })}
			onCancel={() => {
				update.reset()
				onDone()
			}}
		/>
	)
}
