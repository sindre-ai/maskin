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
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

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

type DialogState =
	| { kind: 'closed' }
	| { kind: 'create' }
	| { kind: 'edit'; name: string }
	| { kind: 'delete'; name: string }

function SkillsPage() {
	const { workspaceId } = useWorkspace()
	const { data: skills, isLoading } = useWorkspaceSkills(workspaceId)
	const [dialog, setDialog] = useState<DialogState>({ kind: 'closed' })

	const list = skills ?? []

	return (
		<div>
			<div className="flex items-center justify-between mb-4">
				<p className="text-sm text-muted-foreground">
					Shared skills available to agents in this workspace.
				</p>
				<Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
					<Plus size={14} className="mr-1" />
					Create skill
				</Button>
			</div>

			{isLoading ? (
				<ListSkeleton />
			) : list.length === 0 ? (
				<EmptyState
					title="No skills yet"
					description="Create a skill to share it with agents in this workspace."
					action={
						<Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
							<Plus size={14} className="mr-1" />
							Create skill
						</Button>
					}
				/>
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
				<p className="text-sm font-medium text-foreground truncate">{skill.name}</p>
				{skill.description && (
					<p className="text-xs text-muted-foreground truncate">{skill.description}</p>
				)}
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
			updateMutation.mutate(
				{ name: editingName, data: { content } },
				{ onSuccess: () => onClose(), onError },
			)
		} else {
			createMutation.mutate({ name: name.trim(), content }, { onSuccess: () => onClose(), onError })
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
							disabled={isEdit}
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
