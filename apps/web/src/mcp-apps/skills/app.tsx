import { EmptyState } from '@/components/shared/empty-state'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Pencil, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog } from '../shared/actions'
import { useCallTool, useToolResult } from '../shared/mcp-app-provider'
import { isArray, isObject, safeParseJson, unwrapEnvelope } from '../shared/parse'
import { renderMcpApp } from '../shared/render'
import { WebAppLink } from '../shared/web-app-link'

interface WorkspaceSkillRow {
	id?: string
	name: string
	description: string | null
	storageKey?: string
	sizeBytes?: number
	isValid?: boolean
	createdAt?: string
	updatedAt?: string
	content?: string
}

function SkillsApp() {
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
		case 'list_workspace_skills':
			return isArray(unwrapped) ? (
				<SkillListView skills={unwrapped as WorkspaceSkillRow[]} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'get_workspace_skill':
		case 'create_workspace_skill':
		case 'update_workspace_skill':
			return isObject<WorkspaceSkillRow>(data, 'name') ? (
				<SkillDetailView skill={data} />
			) : (
				<div className="p-4 text-sm text-foreground">{text}</div>
			)
		case 'delete_workspace_skill':
			return <SkillDeletedView />
		default:
			if (isArray(unwrapped)) {
				return <SkillListView skills={unwrapped as WorkspaceSkillRow[]} />
			}
			return <div className="p-4 text-sm text-foreground">{text}</div>
	}
}

function SkillListView({ skills }: { skills: WorkspaceSkillRow[] }) {
	const callTool = useCallTool()
	const [local, setLocal] = useState<WorkspaceSkillRow[]>(skills)
	const [busyName, setBusyName] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [deletingSkill, setDeletingSkill] = useState<WorkspaceSkillRow | null>(null)

	useEffect(() => {
		setLocal(skills)
	}, [skills])

	const onDelete = useCallback(
		async (skill: WorkspaceSkillRow) => {
			setBusyName(skill.name)
			const previous = local
			setLocal((cur) => cur.filter((s) => s.name !== skill.name))
			try {
				await callTool('delete_workspace_skill', { name: skill.name })
			} catch (err) {
				setLocal(previous)
				console.error('Failed to delete skill', err)
			} finally {
				setBusyName(null)
				setDeletingSkill(null)
			}
		},
		[callTool, local],
	)

	return (
		<div className="p-4 space-y-3">
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold text-foreground">Workspace skills</h2>
				<div className="flex items-center gap-2">
					<WebAppLink target={{ kind: 'settings', section: 'skills' }} label="Open in Maskin" />
					<Button size="sm" variant="outline" onClick={() => setCreating((v) => !v)}>
						{creating ? 'Cancel' : 'New skill'}
					</Button>
				</div>
			</div>

			{creating && (
				<SkillCreateForm
					onCreated={(skill) => {
						setLocal((cur) => [skill, ...cur.filter((s) => s.name !== skill.name)])
						setCreating(false)
					}}
					onCancel={() => setCreating(false)}
				/>
			)}

			{!local.length ? (
				<EmptyState
					title="No skills"
					description="Create a workspace skill to make it available to all agents"
				/>
			) : (
				<ul className="space-y-1">
					{local.map((skill) => (
						<li
							key={skill.name}
							className="rounded-lg border border-border bg-bg-surface p-3 flex items-start gap-3"
						>
							<div className="flex-1 min-w-0">
								<div className="text-sm font-medium text-foreground">{skill.name}</div>
								{skill.description && (
									<p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
										{skill.description}
									</p>
								)}
							</div>
							<Button
								size="sm"
								variant="ghost"
								disabled={busyName === skill.name}
								onClick={() => setDeletingSkill(skill)}
								title="Delete"
							>
								<Trash2 className="size-4" />
							</Button>
						</li>
					))}
				</ul>
			)}
			<ConfirmDialog
				open={deletingSkill !== null}
				onOpenChange={(open) => { if (!open) setDeletingSkill(null) }}
				title={`Delete "${deletingSkill?.name ?? ""}"?`}
				description="This permanently removes the skill from the workspace. Any agents using this skill will no longer have access to it."
				confirmLabel="Delete"
				variant="destructive"
				pending={busyName !== null}
				onConfirm={() => { if (deletingSkill) onDelete(deletingSkill) }}
			/>
		</div>
	)
}

function SkillCreateForm({
	onCreated,
	onCancel,
}: {
	onCreated: (skill: WorkspaceSkillRow) => void
	onCancel: () => void
}) {
	const callTool = useCallTool()
	const [name, setName] = useState('')
	const [content, setContent] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async () => {
		if (!name.trim() || !content.trim()) {
			setError('Name and content are required')
			return
		}
		setBusy(true)
		setError(null)
		try {
			const result = await callTool('create_workspace_skill', { name: name.trim(), content })
			const text = result.content?.find(
				(c: { type: string; text?: string }) => c.type === 'text',
			)?.text
			const parsed = text ? safeParseJson(text) : null
			if (isObject<WorkspaceSkillRow>(parsed, 'name')) {
				onCreated(parsed)
			} else {
				onCreated({ name: name.trim(), description: null, content })
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="rounded-lg border border-border bg-card p-3 space-y-2">
			<Input
				placeholder="skill-name"
				value={name}
				onChange={(e) => setName(e.target.value)}
				disabled={busy}
			/>
			<Textarea
				rows={8}
				placeholder={'---\nname: my-skill\ndescription: What this skill does\n---\n\n# Steps\n…'}
				value={content}
				onChange={(e) => setContent(e.target.value)}
				disabled={busy}
				className="font-mono text-xs"
			/>
			{error && <p className="text-xs text-destructive">{error}</p>}
			<div className="flex justify-end gap-2">
				<Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
				<Button size="sm" onClick={submit} disabled={busy}>
					Create skill
				</Button>
			</div>
		</div>
	)
}

function SkillDetailView({ skill }: { skill: WorkspaceSkillRow }) {
	const callTool = useCallTool()
	const [editing, setEditing] = useState(false)
	const [content, setContent] = useState(skill.content ?? '')
	const [busy, setBusy] = useState(false)
	const [current, setCurrent] = useState<WorkspaceSkillRow>(skill)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setCurrent(skill)
		setContent(skill.content ?? '')
	}, [skill])

	const save = async () => {
		setBusy(true)
		setError(null)
		try {
			const result = await callTool('update_workspace_skill', { name: current.name, content })
			const text = result.content?.find(
				(c: { type: string; text?: string }) => c.type === 'text',
			)?.text
			const parsed = text ? safeParseJson(text) : null
			if (isObject<WorkspaceSkillRow>(parsed, 'name')) {
				setCurrent(parsed)
			} else {
				setCurrent({ ...current, content })
			}
			setEditing(false)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="p-4 max-w-3xl space-y-3">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-lg font-semibold text-foreground">{current.name}</h1>
					{current.description && (
						<p className="text-sm text-muted-foreground">{current.description}</p>
					)}
				</div>
				<div className="flex items-center gap-2">
					<WebAppLink target={{ kind: 'settings', section: 'skills' }} label="Open in Maskin" />
					{!editing && (
						<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
							<Pencil className="size-4 mr-1" /> Edit
						</Button>
					)}
				</div>
			</div>

			{editing ? (
				<div className="space-y-2">
					<Textarea
						rows={16}
						value={content}
						onChange={(e) => setContent(e.target.value)}
						disabled={busy}
						className="font-mono text-xs"
					/>
					{error && <p className="text-xs text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
							Cancel
						</Button>
						<Button size="sm" onClick={save} disabled={busy}>
							Save
						</Button>
					</div>
				</div>
			) : current.content ? (
				<div className="rounded border border-border bg-card p-3 prose prose-sm max-w-none dark:prose-invert">
					<MarkdownContent content={current.content} />
				</div>
			) : (
				<p className="text-sm text-muted-foreground">No content available.</p>
			)}
		</div>
	)
}

function SkillDeletedView() {
	return (
		<div className="p-4">
			<EmptyState title="Skill deleted" description="The workspace skill has been removed." />
		</div>
	)
}

renderMcpApp('Skills', <SkillsApp />)
