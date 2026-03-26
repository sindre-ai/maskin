import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useCreateObject } from '@/hooks/use-objects'
import { ApiError } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { getEnabledObjectTypeTabs } from '@ai-native/module-sdk'
import type { createObjectSchema } from '@ai-native/shared'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import type { z } from 'zod'

export function ObjectFormView({
	onSubmit,
	onClose,
	isPending,
	error,
}: {
	onSubmit: (data: z.input<typeof createObjectSchema>) => Promise<void>
	onClose: () => void
	isPending?: boolean
	error?: Error | null
}) {
	const { workspace } = useWorkspace()
	const wsSettings = workspace.settings as Record<string, unknown>
	const enabledModulesRaw = (wsSettings?.enabled_modules as string[]) ?? ['work']
	// biome-ignore lint/correctness/useExhaustiveDependencies: stabilize array reference from JSONB
	const enabledModules = useMemo(() => enabledModulesRaw, [JSON.stringify(enabledModulesRaw)])
	const typeTabs = useMemo(() => getEnabledObjectTypeTabs(enabledModules), [enabledModules])
	const statusMap = (wsSettings?.statuses as Record<string, string[]>) ?? {}

	const [type, setType] = useState(typeTabs[0]?.value ?? 'bet')
	const [title, setTitle] = useState('')
	const [content, setContent] = useState('')

	const fieldErrors = error instanceof ApiError ? error.fieldErrors : {}

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		const defaultStatus = statusMap[type]?.[0] ?? 'new'
		const data: z.input<typeof createObjectSchema> = {
			type,
			title,
			content: content || undefined,
			status: defaultStatus,
		}
		await onSubmit(data)
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<div>
				<Label className="mb-1 text-muted-foreground">Type</Label>
				<div className="flex gap-2">
					{typeTabs.map((t) => (
						<Button
							key={t.value}
							type="button"
							variant={type === t.value ? 'default' : 'secondary'}
							size="sm"
							onClick={() => setType(t.value)}
						>
							{t.label}
						</Button>
					))}
				</div>
				<FormError error={fieldErrors.type} />
			</div>

			<div>
				<Label className="mb-1 text-muted-foreground">Title</Label>
				<Input
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="What's this about?"
					autoFocus
				/>
				<FormError error={fieldErrors.title} />
			</div>

			<div>
				<Label className="mb-1 text-muted-foreground">Content (optional)</Label>
				<Textarea
					value={content}
					onChange={(e) => setContent(e.target.value)}
					placeholder="Describe it... (markdown supported)"
				/>
				<FormError error={fieldErrors.content} />
			</div>

			{error && !(error instanceof ApiError && error.hasFieldErrors()) && (
				<div className="rounded bg-error/10 px-3 py-2 text-sm text-error">
					{error.message || 'Failed to create object'}
				</div>
			)}

			<div className="flex justify-end gap-2 pt-2">
				<Button type="button" variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button type="submit" disabled={!title.trim() || isPending}>
					{isPending ? 'Creating...' : 'Create'}
				</Button>
			</div>
		</form>
	)
}

export function ObjectForm({ onClose }: { onClose: () => void }) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const createObject = useCreateObject(workspaceId)

	const handleSubmit = async (data: z.input<typeof createObjectSchema>) => {
		const created = await createObject.mutateAsync(data)
		onClose()
		navigate({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId, objectId: created.id },
		})
	}

	return (
		<ObjectFormView
			onSubmit={handleSubmit}
			onClose={onClose}
			isPending={createObject.isPending}
			error={createObject.error}
		/>
	)
}
