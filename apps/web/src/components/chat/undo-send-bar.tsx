import { Button } from '@/components/ui/button'

/** Sits above the message box while a sent message is held: Undo takes it back into the box. */
export function UndoSendBar({ onUndo }: { onUndo: () => void }) {
	return (
		<output className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted px-3 py-1 text-sm text-foreground">
			<span>Sending…</span>
			<Button type="button" variant="ghost" size="sm" onClick={onUndo}>
				Undo
			</Button>
		</output>
	)
}
