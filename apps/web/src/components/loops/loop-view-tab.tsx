import { LoopCustomView } from '@/components/loops/loop-custom-view'
import { LoopViewItemPanel } from '@/components/loops/loop-view-item-panel'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useIsMobile } from '@/hooks/use-mobile'
import { useState } from 'react'

/**
 * One custom view as the body of its own tab. A view that cannot be shown says
 * why in a note; leaving the tab and coming back (the page remounts it) retries.
 *
 * When a view asks to open an item, its card shows beside the view (a sheet on a phone), where
 * the person can change its status or approve it. With the flag off, Open goes to the object's
 * page as before.
 */
export function LoopViewTab({
	workspaceId,
	loopId,
	fileId,
}: { workspaceId: string; loopId: string; fileId: string }) {
	const [failure, setFailure] = useState<string | null>(null)
	const [openId, setOpenId] = useState<string | null>(null)
	const itemPanel = useFeatureFlag('loop-view-item-panel')
	const isMobile = useIsMobile()
	// A failed view is unmounted, not just annotated, so its frame is gone from the page.
	if (failure) {
		return (
			<p role="alert" className="text-sm text-muted-foreground">
				This view can't be shown: {failure}
			</p>
		)
	}
	const panel =
		itemPanel && openId !== null ? (
			<LoopViewItemPanel
				workspaceId={workspaceId}
				loopId={loopId}
				objectId={openId}
				onClose={() => setOpenId(null)}
			/>
		) : null
	// The view keeps one place in the tree whether or not the panel is open, so opening an item
	// never reloads it.
	return (
		<div className="flex min-w-0 items-start gap-4">
			<div className="min-w-0 flex-1">
				<LoopCustomView
					workspaceId={workspaceId}
					fileId={fileId}
					onFailure={setFailure}
					onOpenItem={itemPanel ? setOpenId : undefined}
				/>
			</div>
			{panel && !isMobile ? (
				<aside className="sticky top-4 w-[26rem] max-w-[45%] shrink-0">{panel}</aside>
			) : null}
			{panel && isMobile ? (
				<Sheet open onOpenChange={(open) => !open && setOpenId(null)}>
					<SheetContent
						side="right"
						hideCloseButton
						className="w-full overflow-y-auto p-4 sm:max-w-none"
					>
						<SheetTitle className="sr-only">Item</SheetTitle>
						<SheetDescription className="sr-only">
							The item you opened from the view
						</SheetDescription>
						{panel}
					</SheetContent>
				</Sheet>
			) : null}
		</div>
	)
}
