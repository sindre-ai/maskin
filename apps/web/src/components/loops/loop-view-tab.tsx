import { LoopCustomView } from '@/components/loops/loop-custom-view'
import { useState } from 'react'

/**
 * One custom view as the body of its own tab. A view that cannot be shown says
 * why in a note; leaving the tab and coming back (the page remounts it) retries.
 */
export function LoopViewTab({ workspaceId, fileId }: { workspaceId: string; fileId: string }) {
	const [failure, setFailure] = useState<string | null>(null)
	// A failed view is unmounted, not just annotated, so its frame is gone from the page.
	if (failure) {
		return (
			<p role="alert" className="text-sm text-muted-foreground">
				This view can't be shown: {failure}
			</p>
		)
	}
	return <LoopCustomView workspaceId={workspaceId} fileId={fileId} onFailure={setFailure} />
}
