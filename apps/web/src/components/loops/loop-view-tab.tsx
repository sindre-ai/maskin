import { LoopCustomView } from '@/components/loops/loop-custom-view'
import { useState } from 'react'

/**
 * One custom view as the body of its own tab. A view that cannot be shown says
 * why in a note; leaving the tab and coming back (the page remounts it) retries.
 */
export function LoopViewTab({ workspaceId, fileId }: { workspaceId: string; fileId: string }) {
	const [failure, setFailure] = useState<string | null>(null)
	return (
		<>
			{failure && (
				<p role="alert" className="text-sm text-muted-foreground">
					This view can't be shown: {failure}
				</p>
			)}
			<LoopCustomView workspaceId={workspaceId} fileId={fileId} onFailure={setFailure} />
		</>
	)
}
