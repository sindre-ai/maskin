import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/cn'
import type { ComposerFormat } from '@maskin/markdown/react/composer'
import {
	Bold,
	Code,
	Italic,
	Link as LinkIcon,
	List,
	ListOrdered,
	Quote,
	SquareCode,
	Strikethrough,
} from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useCallback, useRef, useState } from 'react'

// The shortcut text is the one the editor binds, so the hint and the key agree.
const FORMATS: {
	format: Exclude<ComposerFormat, 'link'>
	label: string
	shortcut: string
	icon: typeof Bold
}[] = [
	{ format: 'bold', label: 'Bold', shortcut: 'Ctrl+B', icon: Bold },
	{ format: 'italic', label: 'Italic', shortcut: 'Ctrl+I', icon: Italic },
	{ format: 'strike', label: 'Strikethrough', shortcut: 'Ctrl+Shift+X', icon: Strikethrough },
]

const BLOCKS: typeof FORMATS = [
	{ format: 'bulletList', label: 'Bulleted list', shortcut: 'Ctrl+Shift+8', icon: List },
	{ format: 'orderedList', label: 'Numbered list', shortcut: 'Ctrl+Shift+7', icon: ListOrdered },
	{ format: 'blockquote', label: 'Quote', shortcut: 'Ctrl+Shift+B', icon: Quote },
	{ format: 'code', label: 'Inline code', shortcut: 'Ctrl+E', icon: Code },
	{ format: 'codeBlock', label: 'Code block', shortcut: '', icon: SquareCode },
]

const STORAGE_PREFIX = 'composer-formatting:'

/**
 * Whether the format row is open. Remembered per person on this device: a person who turns it on
 * finds it open next time, and another person on the same browser has their own choice.
 */
export function useShowFormatting(actorId: string | null): [boolean, (next: boolean) => void] {
	const key = `${STORAGE_PREFIX}${actorId ?? 'anonymous'}`
	const [show, setShow] = useState(() => {
		try {
			return localStorage.getItem(key) === '1'
		} catch {
			return false
		}
	})
	const set = useCallback(
		(next: boolean) => {
			setShow(next)
			try {
				if (next) localStorage.setItem(key, '1')
				else localStorage.removeItem(key)
			} catch {
				// Losing the choice beats breaking the box.
			}
		},
		[key],
	)
	return [show, set]
}

/** An address a person typed into the link field, with https:// added when it has no scheme. */
export function normalizeLinkUrl(raw: string): string | null {
	const value = raw.trim()
	if (!value) return null
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
	try {
		const url = new URL(withScheme)
		return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? withScheme : null
	} catch {
		return null
	}
}

interface ComposerFormatBarProps {
	active: ComposerFormat[]
	disabled?: boolean
	onToggle: (format: Exclude<ComposerFormat, 'link'>) => void
	onSetLink: (href: string) => void
	onRemoveLink: () => void
	linkHref: () => string | null
	/** Puts the caret back in the box when the link field closes. */
	focusBox: () => void
}

const ITEM_ATTR = 'data-toolbar-item'

const buttonClass =
	'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-md:size-11'

/**
 * The row of format buttons above the message box. Every button runs the same editor command its
 * shortcut runs, so there is one code path. The buttons never take focus from the box, so the
 * selection they act on stays where it is.
 */
export function ComposerFormatBar({
	active,
	disabled = false,
	onToggle,
	onSetLink,
	onRemoveLink,
	linkHref,
	focusBox,
}: ComposerFormatBarProps) {
	const [linkOpen, setLinkOpen] = useState(false)
	const [url, setUrl] = useState('')
	// The address of the link the caret sits in, read once when the field opens.
	const [existingHref, setExistingHref] = useState<string | null>(null)
	const [invalid, setInvalid] = useState(false)
	// The one button Tab lands on. Arrow keys move it, so the row is a single tab stop.
	const [tabStop, setTabStop] = useState<string>(FORMATS[0].format)
	const barRef = useRef<HTMLDivElement>(null)

	const itemProps = (key: string) => ({
		[ITEM_ATTR]: key,
		tabIndex: tabStop === key ? 0 : -1,
	})

	const onBarKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		// The link field renders in a portal but its keys still bubble here through React's tree.
		if (!barRef.current?.contains(e.target as Node)) return
		const items = Array.from(
			barRef.current.querySelectorAll<HTMLButtonElement>(`button[${ITEM_ATTR}]:not(:disabled)`),
		)
		const current = items.indexOf(e.target as HTMLButtonElement)
		if (current === -1) return
		let next: number
		if (e.key === 'ArrowRight') next = (current + 1) % items.length
		else if (e.key === 'ArrowLeft') next = (current - 1 + items.length) % items.length
		else if (e.key === 'Home') next = 0
		else if (e.key === 'End') next = items.length - 1
		else return
		e.preventDefault()
		items[next].focus()
	}

	const button = ({ format, label, shortcut, icon: Icon }: (typeof FORMATS)[number]) => (
		<button
			key={format}
			type="button"
			className={cn(buttonClass, active.includes(format) && 'bg-accent text-accent-foreground')}
			aria-label={label}
			aria-pressed={active.includes(format)}
			title={shortcut ? `${label} (${shortcut})` : label}
			disabled={disabled}
			{...itemProps(format)}
			onMouseDown={(e) => e.preventDefault()}
			onClick={() => onToggle(format)}
		>
			<Icon size={16} aria-hidden />
		</button>
	)

	const submit = (e: FormEvent) => {
		e.preventDefault()
		// The popover renders outside the box in the page but inside it in React's tree, so without
		// this the submit would reach the message form and send the message.
		e.stopPropagation()
		const href = normalizeLinkUrl(url)
		if (!href) return setInvalid(true)
		onSetLink(href)
		setLinkOpen(false)
	}

	return (
		<div
			ref={barRef}
			role="toolbar"
			aria-label="Formatting"
			className="mb-1.5 flex items-center gap-0.5 overflow-x-auto rounded-2xl bg-card px-2 py-1 inset-ring inset-ring-input"
			onKeyDown={onBarKeyDown}
			onFocus={(e) => {
				const key = (e.target as HTMLElement).getAttribute?.(ITEM_ATTR)
				if (key && barRef.current?.contains(e.target as Node)) setTabStop(key)
			}}
		>
			{FORMATS.map(button)}
			<Popover
				open={linkOpen}
				onOpenChange={(next) => {
					if (next) {
						const href = linkHref()
						setExistingHref(href)
						setUrl(href ?? '')
						setInvalid(false)
					}
					setLinkOpen(next)
				}}
			>
				<PopoverTrigger asChild>
					<button
						type="button"
						className={cn(
							buttonClass,
							active.includes('link') && 'bg-accent text-accent-foreground',
						)}
						aria-label="Link"
						aria-pressed={active.includes('link')}
						title="Link"
						disabled={disabled}
						{...itemProps('link')}
						onMouseDown={(e) => e.preventDefault()}
					>
						<LinkIcon size={16} aria-hidden />
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					side="top"
					className="w-80 p-3"
					onCloseAutoFocus={(e) => {
						e.preventDefault()
						focusBox()
					}}
				>
					<form onSubmit={submit} className="flex flex-col gap-2">
						<Input
							value={url}
							onChange={(e) => {
								setUrl(e.target.value)
								setInvalid(false)
							}}
							placeholder="Paste or type a link"
							aria-label="Link address"
							aria-invalid={invalid || undefined}
							autoFocus
						/>
						{invalid ? (
							<p role="alert" className="text-error text-xs">
								Enter a web address or an email link.
							</p>
						) : null}
						<div className="flex justify-end gap-2">
							{existingHref ? (
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onClick={() => {
										onRemoveLink()
										setLinkOpen(false)
									}}
								>
									Remove link
								</Button>
							) : null}
							<Button type="submit" size="sm">
								Apply
							</Button>
						</div>
					</form>
				</PopoverContent>
			</Popover>
			{BLOCKS.map(button)}
		</div>
	)
}
