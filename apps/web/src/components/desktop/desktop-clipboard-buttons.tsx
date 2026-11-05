import { Button } from '@/components/ui/button'
import { type ClipboardRfb, copyFromDesktop, pasteToDesktop } from '@/lib/desktop-clipboard'
import { ClipboardCopy, ClipboardPaste } from 'lucide-react'
import type { RefObject } from 'react'
import { toast } from 'sonner'

/**
 * Paste (browser clipboard to the computer) and Copy (what the computer last
 * copied to the browser clipboard). Shown only while the person is in control.
 * The browser lets a page touch the clipboard only from a click, hence buttons.
 */
export function DesktopClipboardButtons({
	rfbRef,
	remoteText,
	rounded = false,
}: {
	rfbRef: RefObject<ClipboardRfb | null>
	/** The text the computer last copied; empty until something is copied there. */
	remoteText: string
	rounded?: boolean
}) {
	const className = rounded ? 'rounded-full' : undefined

	async function paste() {
		const rfb = rfbRef.current
		if (!rfb) return
		const result = await pasteToDesktop(rfb)
		if (!result.ok) toast.error(result.message)
	}

	async function copy() {
		const result = await copyFromDesktop(remoteText)
		if (result.ok) toast.success('Copied to your clipboard')
		else toast.error(result.message)
	}

	return (
		<>
			<Button
				variant="outline"
				size="sm"
				className={className}
				aria-label="Paste from your clipboard"
				onClick={() => void paste()}
			>
				<ClipboardPaste size={15} />
				<span className="hidden sm:inline">Paste</span>
			</Button>
			<Button
				variant="outline"
				size="sm"
				className={className}
				aria-label="Copy to your clipboard"
				title={remoteText ? undefined : 'Copy something on the computer first'}
				disabled={!remoteText}
				onClick={() => void copy()}
			>
				<ClipboardCopy size={15} />
				<span className="hidden sm:inline">Copy</span>
			</Button>
		</>
	)
}
