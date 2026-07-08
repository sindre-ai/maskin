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
	ResponsivePopover,
	ResponsivePopoverContent,
	ResponsivePopoverTrigger,
} from '@/components/ui/responsive-popover'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
	useAgentSkillAttachments,
	useAttachSkill,
	useDetachSkill,
} from '@/hooks/use-agent-skill-attachments'
import { useDeleteSkill, useSaveSkill, useSkill, useSkills } from '@/hooks/use-skills'
import { useWorkspaceSkills } from '@/hooks/use-workspace-skills'
import type { AttachedWorkspaceSkill, SkillListItem, WorkspaceSkillListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { parseSkillMd } from '@maskin/shared'
import { Link } from '@tanstack/react-router'
import { Command } from 'cmdk'
import {
	BookOpen,
	Building2,
	Check,
	FileText,
	Library,
	type LucideIcon,
	Pencil,
	Plus,
	Trash2,
	User,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

interface SkillsProps {
	actorId: string
}

export function Skills({ actorId }: SkillsProps) {
	const { workspaceId } = useWorkspace()
	const { data: skills, isLoading } = useSkills(actorId, workspaceId)
	const deleteSkill = useDeleteSkill(actorId, workspaceId)

	const [addingSkill, setAddingSkill] = useState(false)
	const [editingSkill, setEditingSkill] = useState<string | null>(null)
	const [importOpen, setImportOpen] = useState(false)

	const handleDelete = useCallback(
		(name: string) => {
			deleteSkill.mutate(name)
		},
		[deleteSkill],
	)

	if (isLoading) {
		return <p className="text-xs text-muted-foreground">Loading skills...</p>
	}

	const skillList = skills ?? []

	return (
		<div>
			<WorkspaceSkillsSection actorId={actorId} workspaceId={workspaceId} />

			<SkillsSectionHeader icon={User} label="Personal" count={skillList.length} className="mt-4" />

			{skillList.length > 0 ? (
				<div className="space-y-2 mb-3">
					{skillList.map((skill) =>
						editingSkill === skill.name ? (
							<SkillForm
								key={skill.name}
								actorId={actorId}
								editingName={skill.name}
								onDone={() => setEditingSkill(null)}
							/>
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
				<p className="text-xs text-muted-foreground mb-3">
					No personal skills configured. Add skills to extend what this agent can do.
				</p>
			)}

			{addingSkill ? (
				<SkillForm actorId={actorId} onDone={() => setAddingSkill(false)} />
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

			<ImportSkillDialog actorId={actorId} open={importOpen} onClose={() => setImportOpen(false)} />
		</div>
	)
}

function WorkspaceSkillsSection({
	actorId,
	workspaceId,
}: {
	actorId: string
	workspaceId: string
}) {
	const { data: workspaceSkills, isLoading: isLoadingWorkspace } = useWorkspaceSkills(workspaceId)
	const { data: attachments, isLoading: isLoadingAttachments } = useAgentSkillAttachments(actorId)
	const attachSkill = useAttachSkill(actorId)
	const detachSkill = useDetachSkill(actorId)
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')

	const isLoading = isLoadingWorkspace || isLoadingAttachments
	const available = [...(workspaceSkills ?? [])].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
	)
	const attached = attachments ?? []
	const attachedIds = new Set(attached.map((s) => s.id))

	const showEmptyState = !isLoading && available.length === 0 && attached.length === 0

	const needle = query.trim().toLowerCase()
	const filtered = needle
		? available.filter(
				(s) =>
					s.name.toLowerCase().includes(needle) ||
					(s.description ?? '').toLowerCase().includes(needle),
			)
		: available

	const handleOpenChange = (next: boolean) => {
		setOpen(next)
		if (!next) setQuery('')
	}

	return (
		<div>
			<SkillsSectionHeader
				icon={Building2}
				label="Workspace"
				count={isLoading ? undefined : attached.length}
			/>

			{isLoading && <p className="text-xs text-muted-foreground">Loading workspace skills...</p>}

			{showEmptyState && (
				<p className="text-xs text-muted-foreground">
					No workspace skills in this workspace yet. Create one in{' '}
					<Link
						to="/$workspaceId/settings/skills"
						params={{ workspaceId }}
						search={{ sort: 'name', order: 'asc' }}
						className="text-primary underline underline-offset-2 hover:opacity-80"
					>
						Settings → Skills
					</Link>
					.
				</p>
			)}

			{!isLoading && available.length > 0 && (
				<ResponsivePopover open={open} onOpenChange={handleOpenChange}>
					<ResponsivePopoverTrigger asChild>
						<Button
							size="sm"
							variant="outline"
							aria-label="Attach workspace skill"
							aria-expanded={open}
						>
							<Plus className="h-3.5 w-3.5 mr-1" />
							Attach workspace skill
						</Button>
					</ResponsivePopoverTrigger>
					<ResponsivePopoverContent
						className="md:w-72 md:p-0"
						align="start"
						accessibleTitle="Attach workspace skill"
					>
						<Command shouldFilter={false}>
							<Command.Input
								value={query}
								onValueChange={setQuery}
								placeholder="Search workspace skills..."
								className="w-full border-b border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none"
							/>
							<Command.List className="max-h-60 overflow-auto p-1">
								<Command.Empty className="py-4 text-center text-xs text-muted-foreground">
									No workspace skills match.
								</Command.Empty>
								{filtered.map((skill) => {
									const isAttached = attachedIds.has(skill.id)
									return (
										<Command.Item
											key={skill.id}
											value={`${skill.name} ${skill.description ?? ''}`}
											onSelect={() => {
												if (isAttached) {
													detachSkill.mutate(skill.id)
												} else {
													attachSkill.mutate(skill.id)
												}
												setOpen(false)
											}}
											className="flex items-center gap-2 rounded px-2 py-1.5 text-sm cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
										>
											<Check
												className={`h-3.5 w-3.5 shrink-0 ${
													isAttached ? 'opacity-100' : 'opacity-0'
												}`}
											/>
											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-1.5">
													<p className="text-sm font-medium truncate">{skill.name}</p>
													{skill.isFolder === true && (
														<FolderBadge fileCount={skill.fileCount ?? 0} />
													)}
												</div>
												{skill.description && (
													<p className="text-xs text-muted-foreground truncate">
														{skill.description}
													</p>
												)}
											</div>
										</Command.Item>
									)
								})}
							</Command.List>
						</Command>
					</ResponsivePopoverContent>
				</ResponsivePopover>
			)}

			{!isLoading && attached.length > 0 && (
				<div className="mt-2 space-y-2">
					{attached.map((skill) => (
						<AttachedSkillRow
							key={skill.id}
							skill={skill}
							onRemove={() => detachSkill.mutate(skill.id)}
						/>
					))}
				</div>
			)}
		</div>
	)
}

function SkillsSectionHeader({
	icon: Icon,
	label,
	count,
	className,
}: {
	icon: LucideIcon
	label: string
	count?: number
	className?: string
}) {
	return (
		<h3
			className={cn(
				'flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2',
				className,
			)}
		>
			<Icon className="h-3.5 w-3.5" aria-hidden="true" />
			<span>{label}</span>
			{count !== undefined && (
				<span aria-label={`${count} ${label.toLowerCase()} skills`}>· {count}</span>
			)}
		</h3>
	)
}

function AttachedSkillRow({
	skill,
	onRemove,
}: {
	skill: AttachedWorkspaceSkill | WorkspaceSkillListItem
	onRemove: () => void
}) {
	const isFolder = skill.isFolder === true
	const fileCount = skill.fileCount ?? 0
	return (
		<div className="flex items-center gap-3 overflow-hidden rounded-md border border-border bg-bg-surface px-3 py-2">
			<Library className="h-4 w-4 text-muted-foreground shrink-0" />
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-1.5">
					<p className="text-sm font-medium text-foreground truncate">{skill.name}</p>
					{isFolder && <FolderBadge fileCount={fileCount} />}
				</div>
				{skill.description && (
					<p className="text-xs text-muted-foreground truncate">{skill.description}</p>
				)}
			</div>
			<Button
				size="sm"
				variant="ghost"
				className="text-muted-foreground shrink-0"
				onClick={onRemove}
				aria-label={`Remove ${skill.name}`}
			>
				Remove
			</Button>
		</div>
	)
}

function FolderBadge({ fileCount }: { fileCount: number }) {
	return (
		<span
			className="inline-flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0"
			aria-label={`Folder skill with ${fileCount} file${fileCount === 1 ? '' : 's'}`}
		>
			<span aria-hidden="true">📁</span>
			<span>
				{fileCount} {fileCount === 1 ? 'file' : 'files'}
			</span>
		</span>
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
		<div className="flex items-center gap-3 overflow-hidden rounded-md border border-border bg-bg-surface px-3 py-2">
			<BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-foreground truncate">{skill.name}</p>
				{skill.description && (
					<p className="text-xs text-muted-foreground truncate">{skill.description}</p>
				)}
			</div>
			{confirmDelete ? (
				<div className="flex items-center gap-1 shrink-0">
					<Button size="sm" variant="destructive" onClick={onDelete}>
						Delete
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
						Cancel
					</Button>
				</div>
			) : (
				<div className="flex items-center gap-1 shrink-0">
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

function SkillForm({
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

	const [name, setName] = useState(editingName ?? '')
	const [description, setDescription] = useState('')
	const [content, setContent] = useState('')
	const [showAdvanced, setShowAdvanced] = useState(false)

	// Advanced frontmatter fields
	const [disableModelInvocation, setDisableModelInvocation] = useState(false)
	const [allowedTools, setAllowedTools] = useState('')
	const [context, setContext] = useState<'none' | 'fork'>('none')
	const [agent, setAgent] = useState('')
	const [model, setModel] = useState('')

	// Load existing skill data when editing
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

		saveSkill.mutate(
			{
				skillName: name.trim(),
				data: {
					description: description.trim(),
					content,
					frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
				},
			},
			{ onSuccess: onDone },
		)
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

			{/* Advanced settings toggle */}
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
				<Button size="sm" onClick={handleSave} disabled={!canSave || saveSkill.isPending}>
					{saveSkill.isPending ? 'Saving...' : 'Save'}
				</Button>
			</div>
		</div>
	)
}

function ImportSkillDialog({
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
			saveSkill.mutate(
				{
					skillName: parsed.name,
					data: {
						description: parsed.description ?? '',
						content: parsed.content,
						frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
					},
				},
				{
					onSuccess: () => {
						setRaw('')
						onClose()
					},
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
					<Button onClick={handleImport} disabled={!raw.trim() || saveSkill.isPending}>
						{saveSkill.isPending ? 'Importing...' : 'Import'}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
