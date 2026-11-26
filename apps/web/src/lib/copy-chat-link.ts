import { toast } from 'sonner'

// Copies the current chat's URL. Shared by the thread header menu and the
// participants popover so both show the same confirmation.
export async function copyChatLink(): Promise<void> {
	try {
		await navigator.clipboard.writeText(window.location.href)
		toast.success('Link copied')
	} catch {
		toast.error('Could not copy link')
	}
}
