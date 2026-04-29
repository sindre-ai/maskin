import { ActorAvatar } from '@/components/shared/actor-avatar'
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
import { useEffect, useRef, useState } from 'react'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import type { ActorResponse, MemberResponse } from '../shared/types'
import { WebAppLink } from '../shared/web-app-link'

type Role = 'owner' | 'admin' | 'member'
const ROLES: Role[] = ['owner', 'admin', 'member']
const ROLE_LABELS: Record<Role, string> = {
	owner: 'Owner',
	admin: 'Admin',
	member: 'Member',
}

interface AddMemberSuccess extends MemberResponse {}

function MembersApp() {
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

	if (
		toolResult.toolName === 'add_workspace_member' &&
		isObject<AddMemberSuccess>(data, 'actorId', 'role')
	) {
		return <MembersAddedView added={data} />
	}
	if (isArray(unwrapped)) {
		return <MembersListView members={unwrapped as MemberResponse[]} />
	}
	return <MembersAddedView added={null} />
}

function MembersListView({ members }: { members: MemberResponse[] }) {
	if (!members.length) {
		return (
			<div className="p-4 space-y-3">
				<EmptyState title="No members" description="No members in this workspace yet" />
				<AddMemberForm />
			</div>
		)
	}
	return (
		<div className="p-4 space-y-3 max-w-3xl">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold text-foreground">Members</h2>
				<WebAppLink target={{ kind: 'settings', section: 'members' }} label="Open in Maskin" />
			</div>
			<ul className="space-y-1">
				{members.map((m) => (
					<li
						key={m.actorId}
						className="flex items-center gap-3 rounded-lg border border-border bg-bg-surface px-3 py-2"
					>
						<ActorAvatar name={m.name} type={m.type} size="sm" />
						<div className="flex-1 min-w-0">
							<div className="text-sm text-foreground">{m.name}</div>
							<div className="text-xs text-muted-foreground capitalize">{m.type}</div>
						</div>
						<span className="text-xs text-muted-foreground capitalize">{m.role}</span>
					</li>
				))}
			</ul>
			<AddMemberForm />
		</div>
	)
}

function MembersAddedView({ added }: { added: AddMemberSuccess | null }) {
	return (
		<div className="p-4 space-y-3 max-w-3xl">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold text-foreground">Workspace members</h2>
				<WebAppLink target={{ kind: 'settings', section: 'members' }} label="Open in Maskin" />
			</div>
			{added && (
				<div className="rounded-lg border border-border bg-card p-3">
					<p className="text-sm text-foreground">
						{added.name ?? 'Member'} added as{' '}
						<span className="font-medium capitalize">{added.role}</span>.
					</p>
				</div>
			)}
			<AddMemberForm />
		</div>
	)
}

function AddMemberForm() {
	const callTool = useCallTool()
	const [actors, setActors] = useState<ActorResponse[]>([])
	const [actorId, setActorId] = useState('')
	const [role, setRole] = useState<Role>('member')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [success, setSuccess] = useState<string | null>(null)
	const callToolRef = useRef(callTool)
	callToolRef.current = callTool

	useEffect(() => {
		callToolRef.current('list_actors', {}).then((result) => {
			const text = result.content?.find(
				(c: { type: string; text?: string }) => c.type === 'text',
			)?.text
			const parsed = text ? safeParseJson(text) : null
			const unwrapped = unwrapEnvelope(parsed)
			if (isArray(unwrapped)) setActors(unwrapped as ActorResponse[])
		})
	}, [])

	const submit = async () => {
		if (!actorId.trim()) {
			setError('Actor ID is required')
			return
		}
		setBusy(true)
		setError(null)
		setSuccess(null)
		try {
			const result = await callTool('add_workspace_member', { actor_id: actorId, role })
			const text = result.content?.find(
				(c: { type: string; text?: string }) => c.type === 'text',
			)?.text
			const parsed = text ? safeParseJson(text) : null
			if (isObject<MemberResponse>(parsed, 'actorId')) {
				setSuccess(`${parsed.name ?? 'Member'} added as ${parsed.role}`)
			} else {
				setSuccess('Member added')
			}
			setActorId('')
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="rounded-lg border border-border bg-card p-3 space-y-2">
			<h3 className="text-sm font-medium text-foreground">Add member</h3>
			<div className="grid grid-cols-[1fr_180px] gap-2">
				<Select value={actorId || ''} onValueChange={setActorId} disabled={busy}>
					<SelectTrigger>
						<SelectValue
							placeholder={actors.length ? 'Pick an actor…' : 'Or paste actor ID below'}
						/>
					</SelectTrigger>
					<SelectContent>
						{actors.map((a) => (
							<SelectItem key={a.id} value={a.id}>
								{a.name} ({a.type})
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select value={role} onValueChange={(v) => setRole(v as Role)} disabled={busy}>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{ROLES.map((r) => (
							<SelectItem key={r} value={r}>
								{ROLE_LABELS[r]}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<Input
				placeholder="…or paste actor UUID"
				value={actorId}
				onChange={(e) => setActorId(e.target.value)}
				disabled={busy}
			/>
			{error && <p className="text-xs text-destructive">{error}</p>}
			{success && <p className="text-xs text-success">{success}</p>}
			<div className="flex justify-end">
				<Button size="sm" onClick={submit} disabled={busy}>
					Add member
				</Button>
			</div>
		</div>
	)
}

renderMcpApp('Members', <MembersApp />)
