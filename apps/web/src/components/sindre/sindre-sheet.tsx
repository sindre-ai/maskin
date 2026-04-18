import { SindreChat } from '@/components/sindre/sindre-chat'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from '@/components/ui/sheet'
import { type SindreAttachment, useSindre } from '@/lib/sindre-context'
import {
	EMPTY_SINDRE_SELECTION,
	type SindreSelectionAgent,
	type SindreSelectionObject,
	sindreSelectionReducer,
} from '@/lib/sindre-selection'
import { useEffect, useReducer } from 'react'

interface SindreSheetProps {
	workspaceId: string
	sindreActorId: string | null
}

/**
 * Right-side Sheet host for Sindre. Drives open state from `SindreContext`
 * and mounts the shared `<SindreChat surface="sheet" />`. Owns the composer
 * selection reducer so chips and the slash picker update one source of truth
 * across the sheet's lifetime; attachments staged by `openWithContext` seed
 * that selection on open (e.g. from a notification "Talk to Sindre" action)
 * and are cleared once consumed.
 */
export function SindreSheet({ workspaceId, sindreActorId }: SindreSheetProps) {
	const { open, setOpen, pendingAttachments, clearPendingAttachments } = useSindre()
	const [selection, dispatch] = useReducer(sindreSelectionReducer, EMPTY_SINDRE_SELECTION)

	useEffect(() => {
		if (pendingAttachments.length === 0) return
		for (const attachment of pendingAttachments) {
			const action = attachmentToAction(attachment)
			if (action) dispatch(action)
		}
		clearPendingAttachments()
	}, [pendingAttachments, clearPendingAttachments])

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetContent side="right" className="flex w-full flex-col sm:max-w-xl">
				<SheetHeader className="pr-6">
					<SheetTitle className="text-base font-semibold">Sindre</SheetTitle>
					<SheetDescription className="sr-only">
						Chat with Sindre, the workspace meta-agent.
					</SheetDescription>
				</SheetHeader>
				<div className="mt-4 flex min-h-0 flex-1 flex-col">
					<SindreChat
						workspaceId={workspaceId}
						sindreActorId={sindreActorId}
						surface="sheet"
						selection={selection}
						onDispatchSelection={dispatch}
					/>
				</div>
			</SheetContent>
		</Sheet>
	)
}

function attachmentToAction(attachment: SindreAttachment) {
	if (attachment.kind === 'agent') {
		const agent: SindreSelectionAgent = {
			id: attachment.id,
			name: attachment.name ?? null,
		}
		return { type: 'add_agent' as const, agent }
	}
	if (attachment.kind === 'object') {
		const object: SindreSelectionObject = {
			id: attachment.id,
			title: attachment.title ?? null,
			type: attachment.type ?? null,
		}
		return { type: 'add_object' as const, object }
	}
	// `notification` attachments are not yet mapped onto selection; callers can
	// extend the reducer to cover them when that surface lands.
	return null
}
