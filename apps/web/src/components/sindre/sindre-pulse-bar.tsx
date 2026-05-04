import { SindreChat } from '@/components/sindre/sindre-chat'
import { type SindreAttachment, useSindre } from '@/lib/sindre-context'
import {
	EMPTY_SINDRE_SELECTION,
	type SindreSelection,
	sindreSelectionReducer,
} from '@/lib/sindre-selection'
import { useCallback, useReducer } from 'react'

interface SindrePulseBarProps {
	workspaceId: string
	sindreActorId: string | null
	className?: string
}

/**
 * Input-only Sindre surface rendered at the top of the Pulse page. Wraps
 * `<SindreChat surface="pulse-bar" />` and intercepts submit so typing in the
 * bar opens the overlay sheet with the message + selection forwarded — the
 * conversation then continues in the sheet where the transcript is visible.
 *
 * The pulse bar holds its own selection reducer so chips and the slash picker
 * update locally while composing; on submit the selection is translated into
 * `SindreAttachment`s and handed to the sheet via `openWithContext`.
 */
export function SindrePulseBar({ workspaceId, sindreActorId, className }: SindrePulseBarProps) {
	const { openWithContext } = useSindre()
	const [selection, dispatch] = useReducer(sindreSelectionReducer, EMPTY_SINDRE_SELECTION)

	const handleSubmit = useCallback(
		(content: string, currentSelection: SindreSelection) => {
			const attachments = selectionToAttachments(currentSelection)
			openWithContext(attachments, content)
			dispatch({ type: 'clear_all' })
		},
		[openWithContext],
	)

	return (
		<SindreChat
			workspaceId={workspaceId}
			sindreActorId={sindreActorId}
			surface="pulse-bar"
			selection={selection}
			onDispatchSelection={dispatch}
			onSubmitOverride={handleSubmit}
			className={className}
		/>
	)
}

function selectionToAttachments(selection: SindreSelection): SindreAttachment[] {
	const attachments: SindreAttachment[] = []
	if (selection.agent) {
		attachments.push({
			kind: 'agent',
			id: selection.agent.id,
			name: selection.agent.name ?? null,
		})
	}
	for (const object of selection.objects) {
		attachments.push({
			kind: 'object',
			id: object.id,
			title: object.title ?? null,
			type: object.type ?? undefined,
		})
	}
	for (const notification of selection.notifications) {
		attachments.push({
			kind: 'notification',
			id: notification.id,
			title: notification.title ?? null,
		})
	}
	return attachments
}
