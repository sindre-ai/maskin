import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { TriggerResponse } from '../shared/types'
import { WebAppLink } from '../shared/web-app-link'

function TriggersApp() {
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

	switch (toolResult.toolName) {
		case 'list_triggers':
			return isArray(unwrapped) ? (
				<TriggerListView triggers={unwrapped as TriggerResponse[]} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'create_trigger':
		case 'update_trigger':
			return isObject<TriggerResponse>(data, 'id', 'name') ? (
				<TriggerDetailView trigger={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'delete_trigger':
			return <TriggerDeletedView />
		default:
			return isObject<TriggerResponse>(data, 'id', 'name') ? (
				<TriggerDetailView trigger={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
	}
}

function TriggerListView({ triggers }: { triggers: TriggerResponse[] }) {
	const callTool = useCallTool()
	const [local, setLocal] = useState<TriggerResponse[]>(triggers)
	const [busyId, setBusyId] = useState<string | null>(null)

	useEffect(() => {
		setLocal(triggers)
	}, [triggers])

	const onToggle = useCallback(
		async (trigger: TriggerResponse) => {
			setBusyId(trigger.id)
			const next = !trigger.enabled
			setLocal((cur) => cur.map((t) => (t.id === trigger.id ? { ...t, enabled: next } : t)))
			try {
				await callTool('update_trigger', { id: trigger.id, enabled: next })
			} catch (err) {
				setLocal((cur) =>
					cur.map((t) => (t.id === trigger.id ? { ...t, enabled: trigger.enabled } : t)),
				)
				console.error('Failed to toggle trigger', err)
			} finally {
				setBusyId(null)
			}
		},
		[callTool],
	)

	const onDelete = useCallback(
		async (trigger: TriggerResponse) => {
			setBusyId(trigger.id)
			const previous = local
			setLocal((cur) => cur.filter((t) => t.id !== trigger.id))
			try {
				await callTool('delete_trigger', { id: trigger.id })
			} catch (err) {
				setLocal(previous)
				console.error('Failed to delete trigger', err)
			} finally {
				setBusyId(null)
			}
		},
		[callTool, local],
	)

	if (!local.length) {
		return <EmptyState title="No triggers" description="No automation triggers configured" />
	}

	return (
		<div className="p-4 space-y-1">
			<div className="flex justify-end mb-2">
				<WebAppLink target={{ kind: 'trigger' }} label="View all in Maskin" />
			</div>
			{local.map((trigger) => (
				<div
					key={trigger.id}
					className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-bg-hover transition-colors border border-border"
				>
					<Switch
						checked={trigger.enabled}
						onCheckedChange={() => onToggle(trigger)}
						disabled={busyId === trigger.id}
						aria-label={`Toggle ${trigger.name}`}
					/>
					<span className="text-sm text-foreground flex-1">{trigger.name}</span>
					<span className="text-xs text-muted-foreground capitalize">{trigger.type}</span>
					<WebAppLink target={{ kind: 'trigger', id: trigger.id }} label="Open" />
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onDelete(trigger)}
						disabled={busyId === trigger.id}
						aria-label={`Delete ${trigger.name}`}
					>
						<Trash2 className="size-3.5" />
					</Button>
				</div>
			))}
		</div>
	)
}

function TriggerDetailView({ trigger }: { trigger: TriggerResponse }) {
	const callTool = useCallTool()
	const [local, setLocal] = useState<TriggerResponse>(trigger)
	const [configText, setConfigText] = useState(() =>
		trigger.config ? JSON.stringify(trigger.config, null, 2) : '{}',
	)
	const [configError, setConfigError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [deleted, setDeleted] = useState(false)
	const [feedback, setFeedback] = useState<string | null>(null)

	useEffect(() => {
		setLocal(trigger)
		setConfigText(trigger.config ? JSON.stringify(trigger.config, null, 2) : '{}')
		setDeleted(false)
		setFeedback(null)
	}, [trigger])

	const update = useCallback(
		async (patch: Partial<TriggerResponse> & { config?: Record<string, unknown> }) => {
			setSaving(true)
			setFeedback(null)
			const optimistic = { ...local, ...patch } as TriggerResponse
			setLocal(optimistic)
			try {
				const body: Record<string, unknown> = { id: trigger.id }
				if ('name' in patch) body.name = patch.name
				if ('actionPrompt' in patch) body.action_prompt = patch.actionPrompt
				if ('targetActorId' in patch) body.target_actor_id = patch.targetActorId
				if ('enabled' in patch) body.enabled = patch.enabled
				if ('config' in patch) body.config = patch.config
				await callTool('update_trigger', body)
				setFeedback('Saved')
			} catch (err) {
				setLocal(local)
				setFeedback(`Failed to save: ${String(err)}`)
			} finally {
				setSaving(false)
			}
		},
		[callTool, local, trigger.id],
	)

	const onSaveConfig = useCallback(async () => {
		try {
			const parsed = JSON.parse(configText)
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				setConfigError('Config must be a JSON object')
				return
			}
			setConfigError(null)
			await update({ config: parsed as Record<string, unknown> })
		} catch (err) {
			setConfigError(`Invalid JSON: ${String(err)}`)
		}
	}, [configText, update])

	const onDelete = useCallback(async () => {
		setSaving(true)
		try {
			await callTool('delete_trigger', { id: trigger.id })
			setDeleted(true)
		} catch (err) {
			setFeedback(`Failed to delete: ${String(err)}`)
		} finally {
			setSaving(false)
		}
	}, [callTool, trigger.id])

	if (deleted) return <TriggerDeletedView />

	return (
		<div className="p-4 max-w-2xl space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-center gap-2">
					<span
						className={`w-2 h-2 rounded-full ${local.enabled ? 'bg-success' : 'bg-muted-foreground'}`}
					/>
					<h1 className="text-lg font-semibold text-foreground">{local.name}</h1>
				</div>
				<WebAppLink target={{ kind: 'trigger', id: trigger.id }} label="Open in Maskin" />
			</div>

			<div className="grid grid-cols-2 gap-4">
				<div className="text-xs text-muted-foreground space-y-1">
					<label htmlFor="trigger-name">Name</label>
					<Input
						id="trigger-name"
						value={local.name}
						onChange={(e) => setLocal({ ...local, name: e.target.value })}
						onBlur={() => local.name !== trigger.name && update({ name: local.name })}
						disabled={saving}
					/>
				</div>
				<div className="text-xs text-muted-foreground space-y-1">
					<span>Type</span>
					<Select value={local.type} disabled>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="cron">cron</SelectItem>
							<SelectItem value="event">event</SelectItem>
							<SelectItem value="reminder">reminder</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>

			<div className="text-xs text-muted-foreground space-y-1 block">
				<label htmlFor="trigger-target-actor">Target agent (actor ID)</label>
				<Input
					id="trigger-target-actor"
					value={local.targetActorId}
					onChange={(e) => setLocal({ ...local, targetActorId: e.target.value })}
					onBlur={() =>
						local.targetActorId !== trigger.targetActorId &&
						update({ targetActorId: local.targetActorId })
					}
					disabled={saving}
				/>
			</div>

			<div className="text-xs text-muted-foreground space-y-1 block">
				<label htmlFor="trigger-action-prompt">Action prompt</label>
				<Textarea
					id="trigger-action-prompt"
					value={local.actionPrompt}
					onChange={(e) => setLocal({ ...local, actionPrompt: e.target.value })}
					onBlur={() =>
						local.actionPrompt !== trigger.actionPrompt &&
						update({ actionPrompt: local.actionPrompt })
					}
					disabled={saving}
					rows={4}
				/>
			</div>

			<div className="text-xs text-muted-foreground space-y-1 block">
				<label htmlFor="trigger-config">
					Config{' '}
					<span className="text-muted-foreground/70">
						(JSON — cron: {`{ "expression": "*/5 * * * *" }`}, event: {`{ "entity_type": ... }`})
					</span>
				</label>
				<Textarea
					id="trigger-config"
					value={configText}
					onChange={(e) => setConfigText(e.target.value)}
					disabled={saving}
					rows={6}
					className="font-mono text-xs"
				/>
				<div className="flex items-center gap-2">
					<Button size="sm" variant="outline" onClick={onSaveConfig} disabled={saving}>
						Save config
					</Button>
					{configError && <span className="text-xs text-destructive">{configError}</span>}
				</div>
			</div>

			<div className="flex items-center justify-between border-t border-border pt-3">
				<div className="flex items-center gap-2">
					<Switch
						checked={local.enabled}
						onCheckedChange={(checked) => update({ enabled: checked })}
						disabled={saving}
						aria-label="Enabled"
					/>
					<span className="text-sm text-foreground">{local.enabled ? 'Enabled' : 'Disabled'}</span>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={onDelete}
					disabled={saving}
					className="text-destructive hover:text-destructive"
				>
					<Trash2 className="size-3.5 mr-1" />
					Delete
				</Button>
			</div>
			{feedback && <p className="text-xs text-muted-foreground">{feedback}</p>}
		</div>
	)
}

function TriggerDeletedView() {
	return (
		<div className="p-4 text-center">
			<p className="text-sm text-muted-foreground">Trigger deleted successfully.</p>
		</div>
	)
}

renderMcpApp('Triggers', <TriggersApp />)
