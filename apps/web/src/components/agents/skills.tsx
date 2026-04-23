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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useDeleteSkill, useSaveSkill, useSkill, useSkills } from '@/hooks/use-skills'
import {
	useDeleteWorkspaceSkill,
	useSaveWorkspaceSkill,
	useWorkspaceSkill,
	useWorkspaceSkills,
} from '@/hooks/use-workspace-skills'
import type { SaveSkillInput, SkillDetail, SkillListItem } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { parseSkillMd } from '@maskin/shared'
import { BookOpen, FileText, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

/**
 * Skills can be scoped to a single actor ("personal skills" attached to one
 * agent) or to a workspace ("team skills" shared by every member and every
 * agent container session running in the workspace).
 */
export type SkillsScope = { kind: 'actor'; actorId: string } | { kind: 'workspace' }

interface SkillsProps {
	scope: SkillsScope
	emptyMessage?: string
}

export function Skills(props: SkillsProps) {
	// One inner component per scope so each one's hook call order is stable.
	return props.scope.kind === 'actor' ? (
		<ActorSkills actorId={props.scope.actorId} emptyMessage={props.emptyMessage} />
	) : (
		<WorkspaceSkills emptyMessage={props.emptyMessage} />
	)
}

function ActorSkills({ actorId, emptyMessage }: { actorId: string; emptyMessage?: string }) {
	const { workspaceId } = useWorkspace()
	const { data: skills, isLoading } = useSkills(actorId, workspaceId)
	const deleteSkill = useDeleteSkill(actorId, workspaceId)

	return (
		<SkillsView
			skills={skills}
			isLoading={isLoading}
			emptyMessage={
				emptyMessage ?? 'No skills configured. Add skills to extend what this agent can do.'
			}
			onDelete={(name) => deleteSkill.mutate(name)}
			renderForm={({ editingName, onDone }) => (
				<ActorSkillForm actorId={actorId} editingName={editingName} onDone={onDone} />
			)}
			renderImport={({ open, onClose }) => (
				<ActorImportDialog actorId={actorId} open={open} onClose={onClose} />
			)}
		/>
	)
}

function WorkspaceSkills({ emptyMessage }: { emptyMessage?: string }) {
	const { workspaceId } = useWorkspace()
	const { data: skills, isLoading } = useWorkspaceSkills(workspaceId)
	const deleteSkill = useDeleteWorkspaceSkill(workspaceId)

	return (
		<SkillsView
			skills={skills}
			isLoading={isLoading}
			emptyMessage={
				emptyMessage ??
				'No team skills yet. Shared skills are visible to every workspace member and every agent session.'
			}
			onDelete={(name) => deleteSkill.mutate(name)}
			renderForm={({ editingName, onDone }) => (
				<WorkspaceSkillForm editingName={editingName} onDone={onDone} />
			)}
			renderImport={({ open, onClose }) => <WorkspaceImportDialog open={open} onClose={onClose} />}
		/>
	)
}

// ── Shared view shell ────────────────────────────────────────────────────

interface SkillsViewProps {
	skills: SkillListItem[] | undefined
	isLoading: boolean
	emptyMessage: string
	onDelete: (name: string) => void
	renderForm: (args: { editingName?: string; onDone: () => void }) => React.ReactNode
	renderImport: (args: { open: boolean; onClose: () => void }) => React.ReactNode
}

function SkillsView({
	skills,
	isLoading,
	emptyMessage,
	onDelete,
	renderForm,
	renderImport,
}: SkillsViewProps) {
	const [addingSkill, setAddingSkill] = useState(false)
	const [editingSkill, setEditingSkill] = useState<string | null>(null)
	const [importOpen, setImportOpen] = useState(false)

	const handleDelete = useCallback(
		(name: string) => {
			onDelete(name)
		},
		[onDelete],
	)

	if (isLoading) {
		return <p className="text-xs text-muted-foreground">Loading skills...</p>
	}

	const skillList = skills ?? []

	return (
		<div>
			{skillList.length > 0 ? (
				<div className="space-y-2 mb-3">
					{skillList.map((skill) =>
						editingSkill === skill.name ? (
							<div key={skill.name}>
								{renderForm({
									editingName: skill.name,
									onDone: () => setEditingSkill(null),
								})}
							</div>
						) : (
							<SkillCard
								key={skill.name}
								skill={skill}
								onEdit={() => setEditingSkill(skill.name)}
								onDelete={() => handleDelete(skill.name)}
							/>
						),
					)}
				</div>
			) : (
				<p className="text-xs text-muted-foreground mb-3">{emptyMessage}</p>
			)}

			{addingSkill ? (
				renderForm({ onDone: () => setAddingSkill(false) })
			) : (
				<div className="flex flex-wrap items-center gap-2">
					<Button size="sm" variant="outline" onClick={() => setAddingSkill(true)}>
						<Plus className="h-3.5 w-3.5 mr-1" />
						Add Skill
					</Button>
					<Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
						<FileText className="h-3.5 w-3.5 mr-1" />
						Import SKILL.md
					</Button>
				</div>
			)}

			{renderImport({ open: importOpen, onClose: () => setImportOpen(false) })}
		</div>
	)
}

function SkillCard({
	skill,
	onEdit,
	onDelete,
}: {
	skill: SkillListItem
	onEdit: () => void
	onDelete: () => void
}) {
	const [confirmDelete, setConfirmDelete] = useState(false)

	return (
		<div className="flex items-center gap-3 rounded-md border border-border bg-bg-surface px-3 py-2">
			<BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-foreground">{skill.name}</p>
				{skill.description && (
					<p className="text-xs text-muted-foreground truncate">{skill.description}</p>
				)}
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
						className="text-muted-foreground"
						onClick={onEdit}
						aria-label="Edit skill"
					>
						<Pencil className="h-3.5 w-3.5" />
					</Button>
					<Button
						size="icon"
						variant="ghost"
						className="text-muted-foreground hover:text-error"
						onClick={() => setConfirmDelete(true)}
						aria-label="Delete skill"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				</div>
			)}
		</div>
	)
}

// ── Form: shared fields + two thin adapters ──────────────────────────────

interface SkillFormSharedProps {
	editingName?: string
	onDone: () => void
	existing: SkillDetail | undefined
	isSaving: boolean
	onSave: (name: string, data: SaveSkillInput) => void
}

function SkillFormShared({
	editingName,
	onDone,
	existing,
	isSaving,
	onSave,
}: SkillFormSharedProps) {
	const [name, setName] = useState(editingName ?? '')
	const [description, setDescription] = useState('')
	const [content, setContent] = useState('')
	const [showAdvanced, setShowAdvanced] = useState(false)

	const [disableModelInvocation, setDisableModelInvocation] = useState(false)
	const [allowedTools, setAllowedTools] = useState('')
	const [context, setContext] = useState<'none' | 'fork'>('none')
	const [agent, setAgent] = useState('')
	const [model, setModel] = useState('')

	useEffect(() => {
		if (existing) {
			setDescription(existing.description)
			setContent(existing.content)
			const fm = existing.frontmatter ?? {}
			setDisableModelInvocation(!!fm.disable_model_invocation)
			setAllowedTools((fm.allowed_tools as string) ?? '')
			setContext(fm.context === 'fork' ? 'fork' : 'none')
			setAgent((fm.agent as string) ?? '')
			setModel((fm.model as string) ?? '')
			if (fm.disable_model_invocation || fm.allowed_tools || fm.context || fm.agent || fm.model) {
				setShowAdvanced(true)
			}
		}
	}, [existing])

	const canSave = name.trim() && description.trim()

	const handleSave = () => {
		if (!canSave) return

		const frontmatter: Record<string, unknown> = {}
		if (disableModelInvocation) frontmatter.disable_model_invocation = true
		if (allowedTools.trim()) frontmatter.allowed_tools = allowedTools.trim()
		if (context === 'fork') frontmatter.context = 'fork'
		if (agent.trim()) frontmatter.agent = agent.trim()
		if (model.trim()) frontmatter.model = model.trim()

		onSave(name.trim(), {
			description: description.trim(),
			content,
			frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
		})
	}

	return (
		<div className="rounded-md border border-border bg-bg-surface p-3 space-y-2">
			<div className="flex gap-2">
				<div className="flex-1">
					<Label>Name</Label>
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. deploy, review-pr"
						className="h-8 text-sm"
						disabled={!!editingName}
					/>
				</div>
			</div>

			<div>
				<Label>Description</Label>
				<Input
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="What this skill does and when to use it"
					className="h-8 text-sm"
				/>
			</div>

			<div>
				<Label>Instructions</Label>
				<Textarea
					value={content}
					onChange={(e) => setContent(e.target.value)}
					placeholder="Markdown instructions for the agent..."
					className="min-h-[120px] font-mono text-sm"
				/>
			</div>

			<Button variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)}>
				{showAdvanced ? 'Hide' : 'Show'} advanced options
			</Button>

			{showAdvanced && (
				<div className="space-y-2 border-t border-border pt-2">
					<div className="flex items-center justify-between">
						<Label>Manual invocation only</Label>
						<Switch checked={disableModelInvocation} onCheckedChange={setDisableModelInvocation} />
					</div>

					<div>
						<Label>Allowed Tools</Label>
						<Input
							value={allowedTools}
							onChange={(e) => setAllowedTools(e.target.value)}
							placeholder="e.g. Read, Grep, Glob"
							className="h-8 text-sm"
						/>
					</div>

					<div className="flex gap-2">
						<div className="flex-1">
							<Label>Context</Label>
							<Select value={context} onValueChange={(v) => setContext(v as 'none' | 'fork')}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="none">Inline</SelectItem>
									<SelectItem value="fork">Fork (subagent)</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{context === 'fork' && (
							<div className="flex-1">
								<Label>Agent Type</Label>
								<Input
									value={agent}
									onChange={(e) => setAgent(e.target.value)}
									placeholder="e.g. Explore, Plan"
									className="h-8 text-sm"
								/>
							</div>
						)}
					</div>

					<div>
						<Label>Model Override</Label>
						<Input
							value={model}
							onChange={(e) => setModel(e.target.value)}
							placeholder="e.g. sonnet, opus"
							className="h-8 text-sm"
						/>
					</div>
				</div>
			)}

			<div className="flex justify-end gap-2 pt-1">
				<Button size="sm" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Button size="sm" onClick={handleSave} disabled={!canSave || isSaving}>
					{isSaving ? 'Saving...' : 'Save'}
				</Button>
			</div>
		</div>
	)
}

function ActorSkillForm({
	actorId,
	editingName,
	onDone,
}: {
	actorId: string
	editingName?: string
	onDone: () => void
}) {
	const { workspaceId } = useWorkspace()
	const saveSkill = useSaveSkill(actorId, workspaceId)
	const { data: existing } = useSkill(actorId, editingName ?? null, workspaceId)

	return (
		<SkillFormShared
			editingName={editingName}
			onDone={onDone}
			existing={existing}
			isSaving={saveSkill.isPending}
			onSave={(name, data) => saveSkill.mutate({ skillName: name, data }, { onSuccess: onDone })}
		/>
	)
}

function WorkspaceSkillForm({
	editingName,
	onDone,
}: {
	editingName?: string
	onDone: () => void
}) {
	const { workspaceId } = useWorkspace()
	const saveSkill = useSaveWorkspaceSkill(workspaceId)
	const { data: existing } = useWorkspaceSkill(workspaceId, editingName ?? null)

	return (
		<SkillFormShared
			editingName={editingName}
			onDone={onDone}
			existing={existing}
			isSaving={saveSkill.isPending}
			onSave={(name, data) => saveSkill.mutate({ skillName: name, data }, { onSuccess: onDone })}
		/>
	)
}

// ── Import: shared shell + two adapters ──────────────────────────────────

interface ImportDialogSharedProps {
	open: boolean
	onClose: () => void
	isSaving: boolean
	onSave: (name: string, data: SaveSkillInput, onSuccess: () => void) => void
}

function ImportDialogShared({ open, onClose, isSaving, onSave }: ImportDialogSharedProps) {
	const [raw, setRaw] = useState('')
	const [error, setError] = useState<string | null>(null)

	const handleImport = () => {
		try {
			const parsed = parseSkillMd(raw)
			if (!parsed.name) {
				setError('SKILL.md must have a "name" field in frontmatter.')
				return
			}

			const frontmatter = Object.fromEntries(
				Object.entries(parsed.frontmatter).filter(([, v]) => v !== undefined),
			)

			setError(null)
			onSave(
				parsed.name,
				{
					description: parsed.description ?? '',
					content: parsed.content,
					frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
				},
				() => {
					setRaw('')
					onClose()
				},
			)
		} catch {
			setError('Invalid SKILL.md format. Expected YAML frontmatter between --- delimiters.')
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (!v) {
					setRaw('')
					setError(null)
					onClose()
				}
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Import SKILL.md</DialogTitle>
					<DialogDescription>
						Paste the contents of a SKILL.md file. It must contain YAML frontmatter with at least a
						"name" field.
					</DialogDescription>
				</DialogHeader>
				<Textarea
					value={raw}
					onChange={(e) => setRaw(e.target.value)}
					placeholder={
						'---\nname: my-skill\ndescription: What this skill does\n---\n\nInstructions for the agent...'
					}
					className="min-h-[200px] font-mono text-sm"
				/>
				{error && <p className="text-xs text-error">{error}</p>}
				<div className="flex justify-end gap-2">
					<Button
						variant="ghost"
						onClick={() => {
							setRaw('')
							setError(null)
							onClose()
						}}
					>
						Cancel
					</Button>
					<Button onClick={handleImport} disabled={!raw.trim() || isSaving}>
						{isSaving ? 'Importing...' : 'Import'}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}

function ActorImportDialog({
	actorId,
	open,
	onClose,
}: {
	actorId: string
	open: boolean
	onClose: () => void
}) {
	const { workspaceId } = useWorkspace()
	const saveSkill = useSaveSkill(actorId, workspaceId)

	return (
		<ImportDialogShared
			open={open}
			onClose={onClose}
			isSaving={saveSkill.isPending}
			onSave={(name, data, onSuccess) => saveSkill.mutate({ skillName: name, data }, { onSuccess })}
		/>
	)
}

function WorkspaceImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const { workspaceId } = useWorkspace()
	const saveSkill = useSaveWorkspaceSkill(workspaceId)

	return (
		<ImportDialogShared
			open={open}
			onClose={onClose}
			isSaving={saveSkill.isPending}
			onSave={(name, data, onSuccess) => saveSkill.mutate({ skillName: name, data }, { onSuccess })}
		/>
	)
}
