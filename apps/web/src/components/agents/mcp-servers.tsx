import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useIntegrations } from '@/hooks/use-integrations'
import type { IntegrationResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { FileJson, Globe, Pencil, Plus, Terminal, Trash2, Zap } from 'lucide-react'
import { useCallback, useState } from 'react'

interface McpServer {
	type?: 'stdio' | 'http'
	// stdio transport
	command?: string
	args?: string[]
	env?: Record<string, string>
	// HTTP transport
	url?: string
	headers?: Record<string, string>
}

type McpServersMap = Record<string, McpServer>

interface McpServersProps {
	tools: Record<string, unknown> | null
	onUpdate: (tools: Record<string, unknown>) => void
}

const INTEGRATION_MCP_PRESETS: Record<string, McpServer> = {
	github: {
		type: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-github'],
		env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
	},
}

const PLATFORM_MCP_PRESET: McpServer = {
	type: 'http',
	url: '${AI_NATIVE_API_URL}/mcp',
	headers: {
		Authorization: 'Bearer ${AI_NATIVE_API_KEY}',
		'X-Workspace-Id': '${AI_NATIVE_WORKSPACE_ID}',
	},
}

function isHttpServer(server: McpServer): boolean {
	return !!server.url
}

function parseServers(tools: Record<string, unknown> | null): McpServersMap {
	if (!tools) return {}
	const servers = tools.mcpServers as McpServersMap | undefined
	return servers ?? {}
}

export function McpServers({ tools, onUpdate }: McpServersProps) {
	const { workspaceId } = useWorkspace()
	const { data: integrations } = useIntegrations(workspaceId)
	const servers = parseServers(tools)
	const serverEntries = Object.entries(servers)

	const [addingServer, setAddingServer] = useState(false)
	const [editingServer, setEditingServer] = useState<string | null>(null)
	const [importOpen, setImportOpen] = useState(false)

	const handleSaveServer = useCallback(
		(name: string, server: McpServer, previousName?: string) => {
			const updated = { ...servers }
			if (previousName && previousName !== name) {
				delete updated[previousName]
			}
			updated[name] = server
			onUpdate({ mcpServers: updated })
			setAddingServer(false)
			setEditingServer(null)
		},
		[servers, onUpdate],
	)

	const handleDeleteServer = useCallback(
		(name: string) => {
			const updated = { ...servers }
			delete updated[name]
			onUpdate({ mcpServers: updated })
		},
		[servers, onUpdate],
	)

	const handleImport = useCallback(
		(imported: McpServersMap) => {
			const merged = { ...servers, ...imported }
			onUpdate({ mcpServers: merged })
			setImportOpen(false)
		},
		[servers, onUpdate],
	)

	const handleQuickAdd = useCallback(
		(provider: string) => {
			const preset = INTEGRATION_MCP_PRESETS[provider]
			if (!preset) return
			const updated = { ...servers, [provider]: preset }
			onUpdate({ mcpServers: updated })
		},
		[servers, onUpdate],
	)

	const handleAddAiNative = useCallback(() => {
		const updated = { ...servers, 'ai-native': PLATFORM_MCP_PRESET }
		onUpdate({ mcpServers: updated })
	}, [servers, onUpdate])

	// Integrations that have MCP presets and are active but not yet added
	const availableQuickAdds = (integrations ?? []).filter(
		(i: IntegrationResponse) =>
			i.status === 'active' && INTEGRATION_MCP_PRESETS[i.provider] && !servers[i.provider],
	)

	const hasAiNative = !!servers['ai-native']

	return (
		<div>
			{/* Server list */}
			{serverEntries.length > 0 ? (
				<div className="space-y-2 mb-3">
					{serverEntries.map(([name, server]) =>
						editingServer === name ? (
							<ServerForm
								key={name}
								initialName={name}
								initialServer={server}
								onSave={(n, s) => handleSaveServer(n, s, name)}
								onCancel={() => setEditingServer(null)}
							/>
						) : (
							<ServerCard
								key={name}
								name={name}
								server={server}
								onEdit={() => setEditingServer(name)}
								onDelete={() => handleDeleteServer(name)}
							/>
						),
					)}
				</div>
			) : (
				<p className="text-xs text-muted-foreground mb-3">
					No MCP servers configured. Add servers to give this agent access to external tools.
				</p>
			)}

			{/* Add server form */}
			{addingServer ? (
				<ServerForm
					onSave={(n, s) => handleSaveServer(n, s)}
					onCancel={() => setAddingServer(false)}
				/>
			) : (
				<div className="flex flex-wrap items-center gap-2">
					{!hasAiNative && (
						<Button size="sm" variant="outline" onClick={handleAddAiNative}>
							<Globe className="h-3.5 w-3.5 mr-1" />
							Add AI Native
						</Button>
					)}
					<Button size="sm" variant="outline" onClick={() => setAddingServer(true)}>
						<Plus className="h-3.5 w-3.5 mr-1" />
						Add Server
					</Button>
					<Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
						<FileJson className="h-3.5 w-3.5 mr-1" />
						Import .mcp.json
					</Button>
					{availableQuickAdds.map((integration: IntegrationResponse) => (
						<Button
							key={integration.id}
							size="sm"
							variant="outline"
							onClick={() => handleQuickAdd(integration.provider)}
						>
							<Zap className="h-3.5 w-3.5 mr-1" />
							Add {integration.provider}
						</Button>
					))}
				</div>
			)}

			{/* Import dialog */}
			<ImportMcpDialog
				open={importOpen}
				onClose={() => setImportOpen(false)}
				onImport={handleImport}
			/>
		</div>
	)
}

function ServerCard({
	name,
	server,
	onEdit,
	onDelete,
}: {
	name: string
	server: McpServer
	onEdit: () => void
	onDelete: () => void
}) {
	const [confirmDelete, setConfirmDelete] = useState(false)
	const http = isHttpServer(server)
	const detailCount = http
		? Object.keys(server.headers ?? {}).length
		: Object.keys(server.env ?? {}).length

	return (
		<div className="flex items-center gap-3 rounded-md border border-border bg-bg-surface px-3 py-2">
			{http ? (
				<Globe className="h-4 w-4 text-muted-foreground shrink-0" />
			) : (
				<Terminal className="h-4 w-4 text-muted-foreground shrink-0" />
			)}
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-foreground">{name}</p>
				<p className="text-xs text-muted-foreground truncate">
					{http ? server.url : `${server.command} ${server.args?.join(' ')}`}
					{detailCount > 0 && (
						<span className="ml-2 text-text-muted">
							{detailCount} {http ? 'header' : 'env var'}
							{detailCount > 1 ? 's' : ''}
						</span>
					)}
				</p>
			</div>
			{confirmDelete ? (
				<div className="flex items-center gap-1">
					<Button size="sm" variant="destructive" onClick={onDelete}>
						Delete
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
						Cancel
					</Button>
				</div>
			) : (
				<div className="flex items-center gap-1">
					<Button
						size="icon"
						variant="ghost"
						className="h-7 w-7 text-muted-foreground"
						onClick={onEdit}
					>
						<Pencil className="h-3.5 w-3.5" />
					</Button>
					<Button
						size="icon"
						variant="ghost"
						className="h-7 w-7 text-muted-foreground hover:text-error"
						onClick={() => setConfirmDelete(true)}
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				</div>
			)}
		</div>
	)
}

function ServerForm({
	initialName = '',
	initialServer,
	onSave,
	onCancel,
}: {
	initialName?: string
	initialServer?: McpServer
	onSave: (name: string, server: McpServer) => void
	onCancel: () => void
}) {
	const initialTransport = initialServer?.url ? 'http' : 'stdio'
	const [name, setName] = useState(initialName)
	const [transport, setTransport] = useState<'stdio' | 'http'>(initialTransport)

	// stdio fields
	const [command, setCommand] = useState(initialServer?.command ?? '')
	const [args, setArgs] = useState(initialServer?.args?.join(', ') ?? '')
	const [nextEnvId, setNextEnvId] = useState(0)
	const [envPairs, setEnvPairs] = useState<Array<{ id: number; key: string; value: string }>>(
		initialServer?.env
			? Object.entries(initialServer.env).map(([key, value], i) => ({ id: i, key, value }))
			: [],
	)

	// HTTP fields
	const [url, setUrl] = useState(initialServer?.url ?? '')
	const [nextHeaderId, setNextHeaderId] = useState(0)
	const [headerPairs, setHeaderPairs] = useState<Array<{ id: number; key: string; value: string }>>(
		initialServer?.headers
			? Object.entries(initialServer.headers).map(([key, value], i) => ({ id: i, key, value }))
			: [],
	)

	const canSave = name.trim() && (transport === 'stdio' ? command.trim() : url.trim())

	const handleSave = () => {
		if (!canSave) return
		if (transport === 'stdio') {
			const env: Record<string, string> = {}
			for (const pair of envPairs) {
				if (pair.key.trim()) env[pair.key.trim()] = pair.value
			}
			onSave(name.trim(), {
				type: 'stdio',
				command: command.trim(),
				args: args
					.split(',')
					.map((a) => a.trim())
					.filter(Boolean),
				env,
			})
		} else {
			const headers: Record<string, string> = {}
			for (const pair of headerPairs) {
				if (pair.key.trim()) headers[pair.key.trim()] = pair.value
			}
			onSave(name.trim(), { type: 'http', url: url.trim(), headers })
		}
	}

	return (
		<div className="rounded-md border border-border bg-bg-surface p-3 space-y-2">
			<div className="flex gap-2">
				<div className="flex-1">
					<Label className="text-xs text-muted-foreground">Name</Label>
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. github"
						className="h-8 text-sm"
					/>
				</div>
				<div className="w-28">
					<Label className="text-xs text-muted-foreground">Transport</Label>
					<Select value={transport} onValueChange={(v) => setTransport(v as 'stdio' | 'http')}>
						<SelectTrigger className="h-8 text-sm">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="stdio">stdio</SelectItem>
							<SelectItem value="http">HTTP</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>

			{transport === 'stdio' ? (
				<>
					<div className="flex gap-2">
						<div className="flex-1">
							<Label className="text-xs text-muted-foreground">Command</Label>
							<Input
								value={command}
								onChange={(e) => setCommand(e.target.value)}
								placeholder="e.g. npx"
								className="h-8 text-sm"
							/>
						</div>
					</div>
					<div>
						<Label className="text-xs text-muted-foreground">Args (comma-separated)</Label>
						<Input
							value={args}
							onChange={(e) => setArgs(e.target.value)}
							placeholder="e.g. -y, @modelcontextprotocol/server-github"
							className="h-8 text-sm"
						/>
					</div>
					<KeyValueEditor
						label="Environment Variables"
						pairs={envPairs}
						onChange={setEnvPairs}
						nextId={nextEnvId}
						onNextId={setNextEnvId}
						keyPlaceholder="KEY"
						valuePlaceholder="value"
					/>
				</>
			) : (
				<>
					<div>
						<Label className="text-xs text-muted-foreground">URL</Label>
						<Input
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="e.g. http://localhost:3000/mcp"
							className="h-8 text-sm"
						/>
					</div>
					<KeyValueEditor
						label="Headers"
						pairs={headerPairs}
						onChange={setHeaderPairs}
						nextId={nextHeaderId}
						onNextId={setNextHeaderId}
						keyPlaceholder="Header-Name"
						valuePlaceholder="value"
					/>
				</>
			)}

			<div className="flex justify-end gap-2 pt-1">
				<Button size="sm" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button size="sm" onClick={handleSave} disabled={!canSave}>
					Save
				</Button>
			</div>
		</div>
	)
}

function KeyValueEditor({
	label,
	pairs,
	onChange,
	nextId,
	onNextId,
	keyPlaceholder,
	valuePlaceholder,
}: {
	label: string
	pairs: Array<{ id: number; key: string; value: string }>
	onChange: (pairs: Array<{ id: number; key: string; value: string }>) => void
	nextId: number
	onNextId: (id: number) => void
	keyPlaceholder: string
	valuePlaceholder: string
}) {
	return (
		<div>
			<div className="flex items-center justify-between mb-1">
				<Label className="text-xs text-muted-foreground">{label}</Label>
				<Button
					size="sm"
					variant="ghost"
					className="h-6 text-xs"
					onClick={() => {
						onChange([...pairs, { id: nextId, key: '', value: '' }])
						onNextId(nextId + 1)
					}}
				>
					<Plus className="h-3 w-3 mr-1" />
					Add
				</Button>
			</div>
			{pairs.map((pair) => (
				<div key={pair.id} className="flex gap-2 mb-1">
					<Input
						value={pair.key}
						onChange={(e) =>
							onChange(pairs.map((p) => (p.id === pair.id ? { ...p, key: e.target.value } : p)))
						}
						placeholder={keyPlaceholder}
						className="h-7 text-xs font-mono flex-1"
					/>
					<Input
						value={pair.value}
						onChange={(e) =>
							onChange(pairs.map((p) => (p.id === pair.id ? { ...p, value: e.target.value } : p)))
						}
						placeholder={valuePlaceholder}
						className="h-7 text-xs font-mono flex-1"
					/>
					<Button
						size="icon"
						variant="ghost"
						className="h-7 w-7 text-muted-foreground hover:text-error shrink-0"
						onClick={() => onChange(pairs.filter((p) => p.id !== pair.id))}
					>
						<Trash2 className="h-3 w-3" />
					</Button>
				</div>
			))}
		</div>
	)
}

function ImportMcpDialog({
	open,
	onClose,
	onImport,
}: {
	open: boolean
	onClose: () => void
	onImport: (servers: McpServersMap) => void
}) {
	const [json, setJson] = useState('')
	const [error, setError] = useState<string | null>(null)

	const handleImport = () => {
		try {
			const parsed = JSON.parse(json)
			if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
				setError('Expected { "mcpServers": { ... } } format')
				return
			}
			setError(null)
			onImport(parsed.mcpServers as McpServersMap)
			setJson('')
		} catch {
			setError('Invalid JSON')
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (!v) {
					setJson('')
					setError(null)
					onClose()
				}
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Import .mcp.json</DialogTitle>
					<DialogDescription>
						Paste the contents of a .mcp.json file. Servers will be merged with existing
						configuration.
					</DialogDescription>
				</DialogHeader>
				<Textarea
					value={json}
					onChange={(e) => setJson(e.target.value)}
					placeholder={
						'{\n  "mcpServers": {\n    "server-name": {\n      "command": "npx",\n      "args": ["-y", "package-name"],\n      "env": {}\n    }\n  }\n}'
					}
					className="min-h-[200px] font-mono text-sm"
				/>
				{error && <p className="text-xs text-error">{error}</p>}
				<div className="flex justify-end gap-2">
					<Button
						variant="ghost"
						onClick={() => {
							setJson('')
							setError(null)
							onClose()
						}}
					>
						Cancel
					</Button>
					<Button onClick={handleImport} disabled={!json.trim()}>
						Import
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
