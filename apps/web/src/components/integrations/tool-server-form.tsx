import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useIntegrations } from '@/hooks/use-integrations'
import type { CustomMcpServerSpec } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { byoApiKeyEnvName, byoLoginEnvNames } from '@maskin/shared'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

type Pair = { id: number; key: string; value: string }

/** A saved Keychain credential a value can point at, instead of holding the secret itself. */
export interface CredentialOption {
	label: string
	/** The env var that stands for it, written into the value as ${NAME}. */
	envName: string
}

/** The workspace's saved API keys and logins, as things a value can refer to. */
export function useCredentialOptions(): CredentialOption[] {
	const { workspaceId } = useWorkspace()
	const { data } = useIntegrations(workspaceId)
	const options: CredentialOption[] = []
	for (const row of data ?? []) {
		if (!row.displayName || (row.status !== 'active' && row.status !== 'pending_undo')) continue
		if (row.providerMode === 'byo_apikey') {
			const envName = byoApiKeyEnvName(row.displayName)
			if (envName) options.push({ label: row.displayName, envName })
		} else if (row.providerMode === 'byo_login') {
			const names = byoLoginEnvNames(row.displayName)
			if (names) {
				options.push({ label: `${row.displayName} · username`, envName: names.username })
				options.push({ label: `${row.displayName} · password`, envName: names.password })
			}
		}
	}
	return options
}

/** The value with the credential's reference added on the end, so "Bearer " + a key works. */
export function withCredential(value: string, envName: string): string {
	return `${value}\${${envName}}`
}

function toPairs(record: Record<string, string> | undefined): Pair[] {
	return Object.entries(record ?? {}).map(([key, value], id) => ({ id, key, value }))
}

function fromPairs(pairs: Pair[]): Record<string, string> {
	const out: Record<string, string> = {}
	for (const pair of pairs) {
		if (pair.key.trim()) out[pair.key.trim()] = pair.value
	}
	return out
}

/**
 * Add or edit one custom MCP server: a name and either a command to run (stdio) or a URL to
 * call (http). Env and header values arrive masked when editing; leave a mask as it is to
 * keep the stored value.
 */
export function ToolServerForm({
	initialName = '',
	initialServer,
	saving = false,
	error,
	onSave,
	onCancel,
}: {
	initialName?: string
	initialServer?: CustomMcpServerSpec
	saving?: boolean
	error?: string | null
	onSave: (name: string, server: CustomMcpServerSpec) => void
	onCancel: () => void
}) {
	const [name, setName] = useState(initialName)
	const [transport, setTransport] = useState<'stdio' | 'http'>(
		initialServer?.url ? 'http' : 'stdio',
	)

	const [command, setCommand] = useState(initialServer?.command ?? '')
	const [args, setArgs] = useState(initialServer?.args?.join(', ') ?? '')
	const [envPairs, setEnvPairs] = useState<Pair[]>(toPairs(initialServer?.env))

	const [url, setUrl] = useState(initialServer?.url ?? '')
	const [headerPairs, setHeaderPairs] = useState<Pair[]>(toPairs(initialServer?.headers))

	const canSave = !!name.trim() && (transport === 'stdio' ? !!command.trim() : !!url.trim())

	const handleSave = () => {
		if (!canSave) return
		if (transport === 'stdio') {
			onSave(name.trim(), {
				type: 'stdio',
				command: command.trim(),
				args: args
					.split(',')
					.map((a) => a.trim())
					.filter(Boolean),
				env: fromPairs(envPairs),
			})
		} else {
			onSave(name.trim(), { type: 'http', url: url.trim(), headers: fromPairs(headerPairs) })
		}
	}

	return (
		<div className="space-y-2 rounded-lg border border-border bg-card p-4">
			<div className="flex flex-wrap gap-2">
				<div className="min-w-0 flex-1 basis-40">
					<Label htmlFor="tool-server-name">Name</Label>
					<Input
						id="tool-server-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. Docs search"
					/>
				</div>
				<div className="w-full sm:w-32">
					<Label>Transport</Label>
					<Select value={transport} onValueChange={(v) => setTransport(v as 'stdio' | 'http')}>
						<SelectTrigger aria-label="Transport">
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
					<div>
						<Label htmlFor="tool-server-command">Command</Label>
						<Input
							id="tool-server-command"
							value={command}
							onChange={(e) => setCommand(e.target.value)}
							placeholder="e.g. npx"
						/>
					</div>
					<div>
						<Label htmlFor="tool-server-args">Args (comma-separated)</Label>
						<Input
							id="tool-server-args"
							value={args}
							onChange={(e) => setArgs(e.target.value)}
							placeholder="e.g. -y, @modelcontextprotocol/server-filesystem"
						/>
					</div>
					<PairEditor
						label="Environment variables"
						pairs={envPairs}
						onChange={setEnvPairs}
						keyPlaceholder="KEY"
						valuePlaceholder="value"
					/>
				</>
			) : (
				<>
					<div>
						<Label htmlFor="tool-server-url">URL</Label>
						<Input
							id="tool-server-url"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="e.g. https://example.com/mcp"
						/>
					</div>
					<PairEditor
						label="Headers"
						pairs={headerPairs}
						onChange={setHeaderPairs}
						keyPlaceholder="Header-Name"
						valuePlaceholder="value"
					/>
				</>
			)}

			{error && <p className="text-xs text-error">{error}</p>}

			<div className="flex justify-end gap-2 pt-1">
				<Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
					Cancel
				</Button>
				<Button size="sm" onClick={handleSave} disabled={!canSave || saving}>
					Save
				</Button>
			</div>
		</div>
	)
}

function PairEditor({
	label,
	pairs,
	onChange,
	keyPlaceholder,
	valuePlaceholder,
}: {
	label: string
	pairs: Pair[]
	onChange: (pairs: Pair[]) => void
	keyPlaceholder: string
	valuePlaceholder: string
}) {
	const credentials = useCredentialOptions()
	const nextId = pairs.reduce((max, p) => Math.max(max, p.id + 1), 0)
	const patch = (id: number, change: Partial<Pair>) =>
		onChange(pairs.map((p) => (p.id === id ? { ...p, ...change } : p)))
	return (
		<div>
			<div className="mb-1 flex items-center justify-between">
				<Label>{label}</Label>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => onChange([...pairs, { id: nextId, key: '', value: '' }])}
				>
					<Plus className="mr-1 h-3 w-3" />
					Add
				</Button>
			</div>
			{pairs.map((pair) => (
				<div key={pair.id} className="mb-1 flex flex-wrap gap-2">
					<Input
						value={pair.key}
						onChange={(e) => patch(pair.id, { key: e.target.value })}
						placeholder={keyPlaceholder}
						aria-label={`${label} name`}
						className="min-w-0 flex-1 font-mono text-xs"
					/>
					<Input
						value={pair.value}
						onChange={(e) => patch(pair.id, { value: e.target.value })}
						placeholder={valuePlaceholder}
						aria-label={`${label} value`}
						className="min-w-0 flex-1 font-mono text-xs"
					/>
					{credentials.length > 0 && (
						// A saved credential instead of a pasted secret: the value keeps a reference, and
						// the Keychain stays the one place the key lives and is rotated.
						<Select
							value=""
							onValueChange={(envName) =>
								patch(pair.id, { value: withCredential(pair.value, envName) })
							}
						>
							<SelectTrigger
								aria-label={`Use a saved credential for ${label.toLowerCase()} ${pair.key || 'row'}`}
								className="w-full sm:w-44"
							>
								<SelectValue placeholder="Saved credential" />
							</SelectTrigger>
							<SelectContent>
								{credentials.map((c) => (
									<SelectItem key={c.envName} value={c.envName}>
										{c.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<Button
						size="icon"
						variant="ghost"
						className="shrink-0 text-muted-foreground hover:text-error"
						aria-label={`Remove ${label.toLowerCase()} row`}
						onClick={() => onChange(pairs.filter((p) => p.id !== pair.id))}
					>
						<Trash2 className="h-3 w-3" />
					</Button>
				</div>
			))}
		</div>
	)
}
