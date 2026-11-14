import { LoopBriefingStage } from '@/components/loops/loop-briefing-stage'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import type { FileListItem } from '@/lib/api'
import { useState } from 'react'

function briefingLabel(file: FileListItem): string {
	const date = new Date(file.createdAt).toLocaleDateString(undefined, {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
	})
	return `${file.name.replace(/\.html?$/i, '')} · ${date}`
}

/**
 * The flow's one briefing tab: the latest briefing in the tall, fitted viewer, and a list of the
 * older ones (newest first, with dates) to open instead. `pages` is newest first.
 */
export function LoopBriefingTab({
	workspaceId,
	pages,
}: {
	workspaceId: string
	pages: FileListItem[]
}) {
	const [pickedId, setPickedId] = useState<string | null>(null)
	const active = pages.find((page) => page.id === pickedId) ?? pages[0]
	if (!active) return null
	return (
		<>
			{pages.length > 1 && (
				<div className="mb-4 px-1">
					<Select value={active.id} onValueChange={setPickedId}>
						<SelectTrigger size="pill" aria-label="Briefing version">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{pages.map((page, i) => (
								<SelectItem key={page.id} value={page.id}>
									{briefingLabel(page)}
									{i === 0 ? ' (latest)' : ''}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}
			<LoopBriefingStage key={active.id} workspaceId={workspaceId} fileId={active.id} />
		</>
	)
}
