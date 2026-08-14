import { isHtml } from '@/components/files/file-body'
import { Button } from '@/components/ui/button'
import type { FileDetail } from '@/lib/api'
import { Star } from 'lucide-react'

interface PinFileButtonProps {
	file: FileDetail
	isPinned: boolean
	onToggle: (fileId: string) => void
}

// "Pin to sidebar" / "Pinned to sidebar" chip shown in the Files viewer bar for
// hosted mini-apps (HTML files). Favorites-state flip follows the approved
// Viewer + Pin mock: star outline → filled and `aria-pressed` toggles, so the
// pressed state is announced to assistive tech. Non-HTML files render nothing.
export function PinFileButton({ file, isPinned, onToggle }: PinFileButtonProps) {
	if (!isHtml(file.mimeType)) return null
	return (
		<Button
			type="button"
			variant={isPinned ? 'secondary' : 'outline'}
			size="sm"
			aria-pressed={isPinned}
			onClick={() => onToggle(file.id)}
		>
			<Star size={14} className={isPinned ? 'fill-current' : undefined} />
			{isPinned ? 'Pinned to sidebar' : 'Pin to sidebar'}
		</Button>
	)
}
