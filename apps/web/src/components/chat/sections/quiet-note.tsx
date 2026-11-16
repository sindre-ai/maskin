import { Button } from '@/components/ui/button'

const NOTE_KEY_PREFIX = 'maskin-chat-list-quiet-note:'

/** Whether this person already dismissed the first-view note. Per person, on this device. */
export function hasSeenQuietNote(actorId: string | undefined): boolean {
	try {
		return localStorage.getItem(`${NOTE_KEY_PREFIX}${actorId ?? 'anonymous'}`) === '1'
	} catch {
		return false
	}
}

export function markQuietNoteSeen(actorId: string | undefined): void {
	try {
		localStorage.setItem(`${NOTE_KEY_PREFIX}${actorId ?? 'anonymous'}`, '1')
	} catch {
		// storage may be unavailable (private mode); the note then shows again next visit
	}
}

function chats(n: number): string {
	return `${n} quiet ${n === 1 ? 'chat' : 'chats'}`
}

/** The one note on the first view after release: chats left the list, and where they went. */
export function QuietNote({
	count,
	onView,
	onDismiss,
}: {
	count: number
	onView: () => void
	onDismiss: () => void
}) {
	return (
		<section
			aria-label="Quiet chats"
			className="mb-2 flex flex-col gap-2 rounded-xl bg-secondary px-3 py-3"
		>
			<p className="text-[13px] font-semibold text-foreground">{chats(count)} left your list</p>
			<p className="text-[12.5px] text-muted-foreground">
				No message for 7 days. Nothing is deleted. They are in Quiet and come back when someone
				writes. Pin a chat or put it in a section to keep it here.
			</p>
			<div className="flex gap-2">
				<Button size="sm" onClick={onView}>
					View Quiet
				</Button>
				<Button size="sm" variant="ghost" onClick={onDismiss}>
					Got it
				</Button>
			</div>
		</section>
	)
}

/** The dashed line at the bottom of the list, so a chat leaving is never a silent disappearance. */
export function QuietFooter({ count, onView }: { count: number; onView: () => void }) {
	return (
		<div className="mx-2 mt-3 flex items-center justify-between gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-[12.5px] text-muted-foreground">
			<span>
				{chats(count)} {count === 1 ? 'is' : 'are'} in Quiet
			</span>
			<Button variant="link" size="sm" onClick={onView}>
				View
			</Button>
		</div>
	)
}
