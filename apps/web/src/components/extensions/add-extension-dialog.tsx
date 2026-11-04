import { slugify } from '@/components/extensions/webhook-form'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCreateExtension } from '@/hooks/use-extensions'
import { ApiError, type ExtensionResponse } from '@/lib/api'
import { useState } from 'react'

const MAX_SLUG_ATTEMPTS = 5
const CALCOM_DOCS_URL =
	'https://github.com/sindre-ai/maskin/blob/main/docs/integrations/calcom/README.md'

/**
 * Names a new extension and creates it as a draft. The slug is derived from the
 * name and cannot change later (it keys the stored secret and the delivery
 * ledger), so it is never asked for; a taken slug gets a numeric suffix.
 */
export function AddExtensionDialog({
	workspaceId,
	existingNames,
	open,
	onOpenChange,
	onCreated,
}: {
	workspaceId: string
	existingNames: string[]
	open: boolean
	onOpenChange: (open: boolean) => void
	onCreated: (ext: ExtensionResponse) => void
}) {
	const create = useCreateExtension(workspaceId)
	const [name, setName] = useState('')
	const [error, setError] = useState<string | null>(null)

	const trimmed = name.trim()
	const baseSlug = slugify(trimmed)
	const duplicate = existingNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())
	const nameError = duplicate ? `You already have an extension called ${trimmed}.` : null
	const canContinue = trimmed.length > 0 && baseSlug.length >= 2 && !duplicate && !create.isPending

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!canContinue) return
		setError(null)
		for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
			const slug = attempt === 1 ? baseSlug : `${baseSlug.slice(0, 44)}-${attempt}`
			try {
				const ext = await create.mutateAsync({ slug, name: trimmed, status: 'draft' })
				setName('')
				onCreated(ext)
				return
			} catch (err) {
				if (err instanceof ApiError && err.status === 409) continue
				setError(err instanceof Error ? err.message : 'Could not create the extension')
				return
			}
		}
		setError('Could not find a free identifier for this name. Try a different name.')
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form onSubmit={handleSubmit} className="grid gap-4">
					<DialogHeader>
						<DialogTitle>Add an extension</DialogTitle>
						<DialogDescription>
							Name it, then add its MCP, its webhook, or both on the next page.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-1.5">
						<Label htmlFor="extension-name">Name</Label>
						<Input
							id="extension-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Fireflies"
							maxLength={80}
							autoFocus
							aria-invalid={!!nameError}
						/>
						<p className="text-xs text-muted-foreground">
							A short label, e.g. Fireflies, Cal.com, Loops.so.
						</p>
						<a
							href={CALCOM_DOCS_URL}
							target="_blank"
							rel="noreferrer"
							className="text-xs text-primary underline underline-offset-2"
						>
							Wire Cal.com bookings to Maskin
						</a>
						<FormError error={nameError ?? error ?? undefined} />
					</div>
					<DialogFooter className="gap-2 sm:gap-0">
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" disabled={!canContinue}>
							Continue
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
