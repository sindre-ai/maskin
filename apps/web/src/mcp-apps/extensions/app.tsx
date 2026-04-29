import { EmptyState } from '@/components/shared/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import { WebAppLink } from '../shared/web-app-link'

interface ExtensionObjectType {
	type: string
	display_name?: string
	statuses?: string[]
	fields?: Array<{ name: string; type: string }>
	relationship_types?: string[]
}

interface ExtensionRow {
	id: string
	name: string
	enabled: boolean
	object_types: ExtensionObjectType[]
}

function ExtensionsApp() {
	const toolResult = useToolResult()

	if (!toolResult) {
		return <div className="p-4 text-muted-foreground text-sm">Waiting for data...</div>
	}

	const text = toolResult.result.content?.find(
		(c: { type: string; text?: string }) => c.type === 'text',
	)?.text
	if (!text) return <div className="p-4 text-muted-foreground text-sm">No data received</div>

	const data = safeParseJson(text)
	if (!data) return <div className="p-4 text-sm text-foreground">{text}</div>

	const unwrapped = unwrapEnvelope(data)

	if (isArray(unwrapped)) {
		return <ExtensionListView extensions={unwrapped as ExtensionRow[]} />
	}
	if (toolResult.toolName === 'create_extension' || toolResult.toolName === 'update_extension') {
		return <ExtensionMutationView label="Updated" data={data} />
	}
	if (toolResult.toolName === 'delete_extension') {
		return (
			<div className="p-4">
				<EmptyState title="Extension deleted" description="The extension has been disabled." />
			</div>
		)
	}
	return <div className="p-4 text-sm text-foreground">{text}</div>
}

function ExtensionListView({ extensions }: { extensions: ExtensionRow[] }) {
	const callTool = useCallTool()
	const [local, setLocal] = useState<ExtensionRow[]>(extensions)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setLocal(extensions)
	}, [extensions])

	const onToggle = async (ext: ExtensionRow) => {
		setBusyId(ext.id)
		setError(null)
		const next = !ext.enabled
		setLocal((cur) => cur.map((e) => (e.id === ext.id ? { ...e, enabled: next } : e)))
		try {
			await callTool('update_extension', { id: ext.id, enabled: next })
		} catch (err) {
			setLocal((cur) => cur.map((e) => (e.id === ext.id ? { ...e, enabled: ext.enabled } : e)))
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusyId(null)
		}
	}

	const onDelete = async (ext: ExtensionRow) => {
		setBusyId(ext.id)
		setError(null)
		const previous = local
		setLocal((cur) => cur.filter((e) => e.id !== ext.id))
		try {
			await callTool('delete_extension', { id: ext.id })
		} catch (err) {
			setLocal(previous)
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusyId(null)
		}
	}

	if (!local.length) {
		return <EmptyState title="No extensions" description="No extensions configured" />
	}

	return (
		<div className="p-4 space-y-3 max-w-3xl">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold text-foreground">Extensions</h2>
				<WebAppLink target={{ kind: 'settings' }} label="Open in Maskin" />
			</div>
			{error && <p className="text-xs text-destructive">{error}</p>}
			<ul className="space-y-2">
				{local.map((ext) => (
					<li
						key={ext.id}
						className="rounded-lg border border-border bg-bg-surface p-3 flex items-start gap-3"
					>
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2 flex-wrap">
								<span className="text-sm font-medium text-foreground">{ext.name}</span>
								<Badge variant={ext.enabled ? 'default' : 'secondary'}>
									{ext.enabled ? 'Enabled' : 'Disabled'}
								</Badge>
								<span className="font-mono text-xs text-muted-foreground">{ext.id}</span>
							</div>
							{ext.object_types && ext.object_types.length > 0 && (
								<div className="mt-1 flex flex-wrap gap-1">
									{ext.object_types.map((ot) => (
										<Badge key={ot.type} variant="outline">
											{ot.display_name ?? ot.type}
										</Badge>
									))}
								</div>
							)}
						</div>
						<div className="flex items-center gap-2 shrink-0">
							<Switch
								checked={ext.enabled}
								disabled={busyId === ext.id}
								onCheckedChange={() => onToggle(ext)}
								aria-label={`Toggle ${ext.name}`}
							/>
							{ext.id !== 'work' && (
								<Button
									size="sm"
									variant="ghost"
									disabled={busyId === ext.id}
									onClick={() => onDelete(ext)}
									title="Delete"
								>
									<Trash2 className="size-4" />
								</Button>
							)}
						</div>
					</li>
				))}
			</ul>
		</div>
	)
}

function ExtensionMutationView({ label, data }: { label: string; data: unknown }) {
	const summary = isObject<{ name?: string; id?: string }>(data)
		? `${label} ${data.name ?? data.id ?? 'extension'}.`
		: `${label}.`
	return (
		<div className="p-4 max-w-3xl space-y-2">
			<EmptyState title={`Extension ${label.toLowerCase()}`} description={summary} />
			<div className="flex justify-end">
				<WebAppLink target={{ kind: 'settings' }} label="Open settings in Maskin" />
			</div>
		</div>
	)
}

renderMcpApp('Extensions', <ExtensionsApp />)
