import { Button } from '@/components/ui/button'
import { trackEvent } from '@/lib/analytics'
import { api } from '@/lib/api'
import { useEffect, useRef, useState } from 'react'

interface NorthStarPromptCardProps {
	workspaceId: string
	onDismiss: () => void
}

export function NorthStarPromptCard({ workspaceId, onDismiss }: NorthStarPromptCardProps) {
	const [value, setValue] = useState('')
	const [isSubmitting, setIsSubmitting] = useState(false)
	const impressionFired = useRef(false)

	useEffect(() => {
		if (impressionFired.current) return
		impressionFired.current = true
		trackEvent('north_star_prompt_impression', { workspace_id: workspaceId })
	}, [workspaceId])

	async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
		e.preventDefault()
		const trimmed = value.trim()
		if (!trimmed || isSubmitting) return
		setIsSubmitting(true)
		try {
			trackEvent('north_star_prompt_response', { workspace_id: workspaceId })
			await api.workspaces.update(workspaceId, {
				settings: { north_star_metric: trimmed },
			})
			localStorage.setItem(`north_star_answered_${workspaceId}`, '1')
			onDismiss()
		} catch {
			setIsSubmitting(false)
		}
	}

	return (
		<div className="rounded-lg border border-border bg-card">
			<div className="border-b border-border px-4 py-3">
				<p className="text-sm font-medium">What's your product's North Star metric?</p>
			</div>
			<form onSubmit={handleSubmit} className="px-4 py-3">
				<div className="flex gap-2">
					<input
						type="text"
						value={value}
						onChange={(e) => setValue(e.target.value)}
						placeholder="e.g. Weekly Active Users"
						className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					/>
					<Button type="submit" size="sm" disabled={!value.trim() || isSubmitting}>
						{isSubmitting ? 'Saving…' : 'Save'}
					</Button>
				</div>
			</form>
		</div>
	)
}
