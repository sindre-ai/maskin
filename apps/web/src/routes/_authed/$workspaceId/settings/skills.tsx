import { EmptyState } from '@/components/shared/empty-state'
import { FormError } from '@/components/shared/form-error'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
	useCreateWorkspaceSkill,
	useDeleteWorkspaceSkill,
	useUpdateWorkspaceSkill,
	useWorkspaceSkill,
	useWorkspaceSkills,
} from '@/hooks/use-workspace-skills'
import { ApiError, type WorkspaceSkillListItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { parseSkillMd, skillNameSchema } from '@maskin/shared'
import { createFileRoute } from '@tanstack/react-router'
import { AlertTriangle, FileUp, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/skills')({
	component: SkillsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when to use it
---

Instructions for the agent...
`

const MAX_UPLOAD_RETRIES = 5

type DialogState =
	| { kind: 'closed' }
	| { kind: 'create' }
	| { kind: 'edit'; name: string }
	| { kind: 'delete'; name: string }

type UploadSummary = { imported: number; failed: { name: string; reason: string }[] }

function SkillsPage() {
	const { workspaceId } = useWorkspace()
	const { data: skills, isLoading } = useWorkspaceSkills(workspaceId)
	const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })
	const createMutation = useCreateWorkspaceSkill(workspaceId)
	const [isDragging, setIsDragging] = useState(false)
	const [isUploading, setIsUploading] = useState(false)
	const [summary, setSummary] = useState<UploadSummary | null>(null)
	const inputRef = useRef<HTMLInputElement>(null)

	const list = skills ?? []
	const existingNames = list.map((s) => s.name)

	const handleFiles = useCallback(
		async (files: FileList | File[]) => {
			const fileList = Array.from(files).filter((f) => f.size > 0)
			if (fileList.length === 0) return

			setIsUploading(true)
			setSummary(null)

			// Track names claimed by in-flight uploads so two invalid files that
			// sanitise to the same base name get unique suffixes.
			const claimed = new Set(existingNames)
			const result: UploadSummary = { imported: 0, failed: [] }

			const uploads = fileList.map(async (file) => {
				const text = await file.text()
				const { baseName, content } = toSkillUpload(text, file.name)
				let name = uniqueName(baseName, claimed)
				claimed.add(name)

				for (let attempt = 0; attempt < MAX_UPLOAD_RETRIES; attempt++) {
					try {
						await createMutation.mutateAsync({ name, content })
						result.imported++
						return
					} catch (err) {
						if (err instanceof ApiError && err.status === 409) {
							// Race with another tab / another file that sanitised the
							// same way — pick the next suffix and retry.
							claimed.add(name)
							name = uniqueName(baseName, claimed)
							claimed.add(name)
							continue
						}
						const reason =
							err instanceof ApiError || err instanceof Error ? err.message : 'Upload failed'
						result.failed.push({ name: file.name, reason })
						return
					}
				}
				result.failed.push({ name: file.name, reason: 'Too many name collisions' })
			})

			await Promise.allSettled(uploads)
			setIsUploading(false)
			setSummary(result)
		},
		[createMutation, existingNames],
	)

	const openFilePicker = useCallback(() => inputRef.current?.click(), [])

	const handleFileChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			if (e.target.files && e.target.files.length > 0) {
				void handleFiles(e.target.files)
			}
			// Reset so the same file can be re-selected later.
			e.target.value = ''
		},
		[handleFiles],
	)

	const dropHandlers = {
		onDragOver: (e: React.DragEvent) => {
			e.preventDefault()
			setIsDragging(true)
		},
		onDragLeave: () => setIsDragging(false),
		onDrop: (e: React.DragEvent) => {
			e.preventDefault()
			setIsDragging(false)
			if (e.dataTransfer.files.length > 0) {
				void handleFiles(e.dataTransfer.files)
			}
		},
	}

	const headerActions = (
		<div className="flex items-center gap-2">
			<Button variant="outline" size="sm" onClick={openFilePicker} disabled={isUploading}>
				<FileUp size={14} className="mr-1" />
				Browse files
			</Button>
			<Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
				<Plus size={14} className="mr-1" />
				Create skill
			</Button>
		</div>
	)

	return (
		<div>
			<div className="flex items-center justify-between mb-4">
				<p className="text-sm text-muted-foreground">
					Shared skills available to agents in this workspace.
				</p>
				{headerActions}
			</div>

			{isLoading ? (
				<ListSkeleton />
			) : list.length === 0 ? (
				<div
					{...dropHandlers}
					className={cn(
						'rounded-lg border-2 border-dashed transition-colors',
						isDragging ? 'border-accent bg-accent/5' : 'border-border',
						isUploading && 'pointer-events-none opacity-50',
					)}
				>
					<EmptyState
						title={
							isUploading
								? 'Uploading skill files...'
								: isDragging
									? 'Drop SKILL.md files to import'
									: 'No skills yet'
						}
						description="Create a skill, browse for SKILL.md files, or drag and drop them here. Files that don't match the SKILL.md format are still added so you can fix them."
						action={
							<div className="flex items-center gap-2">
								<Button variant="outline" size="sm" onClick={openFilePicker} disabled={isUploading}>
									<FileUp size={14} className="mr-1" />
									Browse files
								</Button>
								<Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
									<Plus size={14} className="mr-1" />
									Create skill
								</Button>
							</div>
						}
					/>
				</div>
			) : (
				<div className="space-y-2">
					{list.map((skill) => (
						<SkillRow
							key={skill.id}
							skill={skill}
							onEdit={() => setDialog({ kind: 'edit', name: skill.name })}
							onDelete={() => setDialog({ kind: 'delete', name: skill.name })}
						/>
					))}
				</div>
			)}

			{summary && (summary.imported > 0 || summary.failed.length > 0) && (
				<div className="mt-3 text-xs text-muted-foreground">
					{summary.imported > 0 && (
						<span>
							Imported {summary.imported} file{summary.imported === 1 ? '' : 's'}.
						</span>
					)}
					{summary.failed.length > 0 && (
						<span className="ml-1 text-error">
							{summary.failed.length} failed ({summary.failed[0]?.reason})
						</span>
					)}
				</div>
			)}

			<input
				ref={inputRef}
				type="file"
				accept=".md,.markdown,text/markdown"
				multiple
				className="hidden"
				onChange={handleFileChange}
			/>

			{(dialog.kind === 'create' || dialog.kind === 'edit') && (
				<SkillDialog
					workspaceId={workspaceId}
					editingName={dialog.kind === 'edit' ? dialog.name : null}
					onClose={() => setDialog({ kind: 'closed' })}
				/>
			)}

			{dialog.kind === 'delete' && (
				<DeleteSkillDialog
					workspaceId={workspaceId}
					name={dialog.name}
					onClose={() => setDialog({ kind: 'closed' })}
				/>
			)}
		</div>
	)
}

function SkillRow({
	skill,
	onEdit,
	onDelete,
}: {
	skill: WorkspaceSkillListItem
	onEdit: () => void
	onDelete: () => void
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					{!skill.isValid && (
						<span
							className="shrink-0 text-warning"
							title="Invalid SKILL.md format — edit to fix"
							aria-label="Invalid SKILL.md format"
						>
							<AlertTriangle size={14} />
						</span>
					)}
					<p className="text-sm font-medium text-foreground truncate">{skill.name}</p>
				</div>
				{skill.description ? (
					<p className="text-xs text-muted-foreground truncate">{skill.description}</p>
				) : !skill.isValid ? (
					<p className="text-xs text-warning truncate">
						Won't be loaded by agents until the format is fixed
					</p>
				) : null}
			</div>
			<RelativeTime date={skill.updatedAt} className="text-xs text-muted-foreground shrink-0" />
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="text-muted-foreground"
						aria-label={`Actions for ${skill.name}`}
					>
						<MoreHorizontal size={16} />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={onEdit}>
						<Pencil size={14} className="mr-2" />
						Edit
					</DropdownMenuItem>
					<DropdownMenuItem onClick={onDelete} className="text-error focus:text-error">
						<Trash2 size={14} className="mr-2" />
						Delete
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}

function SkillDialog({
	workspaceId,
	editingName,
	onClose,
}: {
	workspaceId: string
	editingName: string | null
	onClose: () => void
}) {
	const isEdit = editingName !== null
	const existing = useWorkspaceSkill(workspaceId, editingName)
	const createMutation = useCreateWorkspaceSkill(workspaceId)
	const updateMutation = useUpdateWorkspaceSkill(workspaceId)

	const [name, setName] = useState(editingName ?? '')
	const [content, setContent] = useState(isEdit ? '' : SKILL_TEMPLATE)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (existing.data) {
			setContent(existing.data.content)
		}
	}, [existing.data])

	const pending = createMutation.isPending || updateMutation.isPending
	const loadingExisting = isEdit && existing.isLoading
	const canSave =
		!pending && !loadingExisting && name.trim().length > 0 && content.trim().length > 0

	const handleSave = () => {
		setError(null)
		const trimmedName = name.trim()

		const nameResult = skillNameSchema.safeParse(trimmedName)
		if (!nameResult.success) {
			setError(nameResult.error.issues[0]?.message ?? 'Invalid skill name')
			return
		}

		const onError = (err: unknown) => {
			if (err instanceof ApiError) {
				setError(err.message)
			} else if (err instanceof Error) {
				setError(err.message)
			} else {
				setError('Failed to save skill')
			}
		}

		if (isEdit && editingName) {
			const renamed = trimmedName !== editingName
			updateMutation.mutate(
				{
					name: editingName,
					data: renamed ? { name: trimmedName, content } : { content },
					newName: renamed ? trimmedName : undefined,
				},
				{ onSuccess: () => onClose(), onError },
			)
		} else {
			createMutation.mutate({ name: trimmedName, content }, { onSuccess: () => onClose(), onError })
		}
	}

	return (
		<Dialog open onOpenChange={(v) => !v && onClose()}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{isEdit ? 'Edit skill' : 'Create skill'}</DialogTitle>
					<DialogDescription>
						Skills are shared across this workspace. Agents only receive the skills attached to
						them.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div>
						<Label htmlFor="skill-name">Name</Label>
						<Input
							id="skill-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. deploy, review-pr"
							autoFocus={!isEdit}
						/>
					</div>
					<div>
						<Label htmlFor="skill-content">SKILL.md</Label>
						<Textarea
							id="skill-content"
							value={content}
							onChange={(e) => setContent(e.target.value)}
							placeholder={SKILL_TEMPLATE}
							className="min-h-[280px] font-mono text-sm"
							disabled={loadingExisting}
						/>
					</div>
					<FormError error={error ?? undefined} />
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={pending}>
						Cancel
					</Button>
					<Button onClick={handleSave} disabled={!canSave}>
						{pending ? 'Saving...' : 'Save'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function DeleteSkillDialog({
	workspaceId,
	name,
	onClose,
}: {
	workspaceId: string
	name: string
	onClose: () => void
}) {
	const deleteMutation = useDeleteWorkspaceSkill(workspaceId)
	const [error, setError] = useState<string | null>(null)

	const handleDelete = () => {
		setError(null)
		deleteMutation.mutate(name, {
			onSuccess: () => onClose(),
			onError: (err) => {
				if (err instanceof ApiError) setError(err.message)
				else if (err instanceof Error) setError(err.message)
				else setError('Failed to delete skill')
			},
		})
	}

	return (
		<Dialog open onOpenChange={(v) => !v && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete skill</DialogTitle>
					<DialogDescription>
						Delete <span className="font-mono text-foreground">{name}</span>? This will detach it
						from any agents that currently use it.
					</DialogDescription>
				</DialogHeader>
				<FormError error={error ?? undefined} />
				<DialogFooter>
					<Button variant="ghost" onClick={onClose} disabled={deleteMutation.isPending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
						{deleteMutation.isPending ? 'Deleting...' : 'Delete'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function toSkillUpload(
	text: string,
	fileName: string,
): { baseName: string; content: string } {
	try {
		const parsed = parseSkillMd(text)
		if (skillNameSchema.safeParse(parsed.name).success) {
			return { baseName: parsed.name, content: text }
		}
	} catch {
		// Fall through to filename-derived name.
	}
	return { baseName: deriveNameFromFileName(fileName), content: text }
}

export function deriveNameFromFileName(fileName: string): string {
	const withoutExt = fileName.replace(/\.(md|markdown)$/i, '')
	const sanitised = withoutExt
		.toLowerCase()
		.replace(/[\s_]+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
	return sanitised.length > 0 ? sanitised : 'imported-skill'
}

export function uniqueName(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`.slice(0, 64)
		if (!taken.has(candidate)) return candidate
	}
	return `${base}-${Date.now()}`.slice(0, 64)
}
