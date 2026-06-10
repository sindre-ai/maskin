import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/cn'
import { Check, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface Annotation {
	id: string
	pinNumber: number
	selector: string
	bounds: { x: number; y: number; w: number; h: number }
	comment: string
	position: { x: number; y: number } // fractions (0–1) of iframe dimensions
}

interface AnnotationOverlayProps {
	html: string
	name: string
	annotations: Annotation[]
	onAnnotationsChange: (annotations: Annotation[]) => void
}

// Injected into the sandboxed iframe to respond to elementFromPoint queries.
// The sandbox has allow-scripts but not allow-same-origin, so we must communicate
// via postMessage — direct contentDocument access is not available.
const LISTENER_SCRIPT = `<script>(function(){
window.addEventListener('message',function(e){
  if(!e.data||e.data.type!=='MASKIN_GET_ELEMENT')return;
  try{
    var el=document.elementFromPoint(e.data.x,e.data.y);
    var sel='body';
    var b={x:0,y:0,w:0,h:0};
    if(el){
      if(el.id){sel='#'+CSS.escape(el.id);}
      else{
        var t=el.tagName.toLowerCase();
        var cs=Array.from(el.classList).slice(0,2).map(function(c){return'.'+CSS.escape(c);}).join('');
        sel=cs?t+cs:t;
      }
      var r=el.getBoundingClientRect();
      b={x:r.left/window.innerWidth,y:r.top/window.innerHeight,w:r.width/window.innerWidth,h:r.height/window.innerHeight};
    }
    e.source.postMessage({type:'MASKIN_ELEMENT_RESULT',id:e.data.id,selector:sel,bounds:b},'*');
  }catch(_){
    e.source.postMessage({type:'MASKIN_ELEMENT_RESULT',id:e.data.id,selector:'',bounds:{x:0,y:0,w:0,h:0}},'*');
  }
});
})();<\/script>`

export function injectScript(html: string): string {
	const lower = html.toLowerCase()
	const headIdx = lower.indexOf('<head>')
	if (headIdx !== -1) {
		return html.slice(0, headIdx + 6) + LISTENER_SCRIPT + html.slice(headIdx + 6)
	}
	// Insert after the doctype declaration's closing > so the script never precedes <!DOCTYPE>
	const doctypeIdx = lower.indexOf('<!doctype')
	if (doctypeIdx !== -1) {
		const closeIdx = html.indexOf('>', doctypeIdx)
		if (closeIdx !== -1) {
			return html.slice(0, closeIdx + 1) + LISTENER_SCRIPT + html.slice(closeIdx + 1)
		}
	}
	// Second fallback: before <body
	const bodyIdx = lower.indexOf('<body')
	if (bodyIdx !== -1) {
		return html.slice(0, bodyIdx) + LISTENER_SCRIPT + html.slice(bodyIdx)
	}
	return LISTENER_SCRIPT + html
}

export function AnnotationOverlay({
	html,
	name,
	annotations,
	onAnnotationsChange,
}: AnnotationOverlayProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null)
	const overlayRef = useRef<HTMLDivElement>(null)
	const [openPinId, setOpenPinId] = useState<string | null>(null)
	const [draft, setDraft] = useState('')
	const nextPin = useRef(
		annotations.length > 0 ? Math.max(...annotations.map((a) => a.pinNumber)) + 1 : 1,
	)

	const injectedHtml = useMemo(() => injectScript(html), [html])

	// Listen for elementFromPoint responses from the sandboxed iframe
	useEffect(() => {
		function onMessage(e: MessageEvent) {
			if (e.source !== iframeRef.current?.contentWindow) return
			if (!e.data || typeof e.data !== 'object') return
			if (e.data.type !== 'MASKIN_ELEMENT_RESULT') return
			const { id, selector, bounds } = e.data as {
				id: string
				selector: string
				bounds: { x: number; y: number; w: number; h: number }
			}
			onAnnotationsChange(
				annotations.map((a) =>
					a.id === id ? { ...a, selector: selector ?? '', bounds: bounds ?? a.bounds } : a,
				),
			)
		}
		window.addEventListener('message', onMessage)
		return () => window.removeEventListener('message', onMessage)
	}, [annotations, onAnnotationsChange])

	const placePin = useCallback(
		(clientX: number, clientY: number) => {
			const overlay = overlayRef.current
			const iframe = iframeRef.current
			if (!overlay || !iframe) return

			const rect = overlay.getBoundingClientRect()
			const fx = (clientX - rect.left) / rect.width
			const fy = (clientY - rect.top) / rect.height

			// Pixel coordinates inside the iframe viewport
			const ix = fx * iframe.clientWidth
			const iy = fy * iframe.clientHeight

			const id = crypto.randomUUID()
			const pinNumber = nextPin.current++

			onAnnotationsChange([
				...annotations,
				{
					id,
					pinNumber,
					selector: '',
					bounds: { x: 0, y: 0, w: 0, h: 0 },
					comment: '',
					position: { x: fx, y: fy },
				},
			])
			setOpenPinId(id)
			setDraft('')

			iframe.contentWindow?.postMessage({ type: 'MASKIN_GET_ELEMENT', id, x: ix, y: iy }, '*')
		},
		[annotations, onAnnotationsChange],
	)

	const handleOverlayClick = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			placePin(e.clientX, e.clientY)
		},
		[placePin],
	)

	// Allow keyboard users to place a pin at the center of the overlay
	const handleOverlayKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault()
				const overlay = overlayRef.current
				if (!overlay) return
				const rect = overlay.getBoundingClientRect()
				placePin(rect.left + rect.width / 2, rect.top + rect.height / 2)
			}
		},
		[placePin],
	)

	function openPin(id: string, currentComment: string) {
		setDraft(currentComment)
		setOpenPinId(id)
	}

	function saveComment(id: string) {
		onAnnotationsChange(annotations.map((a) => (a.id === id ? { ...a, comment: draft } : a)))
		setOpenPinId(null)
	}

	function removeAnnotation(id: string) {
		onAnnotationsChange(annotations.filter((a) => a.id !== id))
		if (openPinId === id) setOpenPinId(null)
	}

	return (
		<div className="resize overflow-hidden rounded-md border border-border bg-bg-surface w-full h-[60vh] min-h-[20vh] max-h-[200vh] max-w-[calc(100vw-4rem)] relative">
			<iframe
				ref={iframeRef}
				title={`Preview of ${name}`}
				srcDoc={injectedHtml}
				sandbox="allow-scripts"
				className="w-full h-full block"
			/>

			{/* Transparent overlay — captures pointer events to place pins */}
			<div
				ref={overlayRef}
				role="button"
				tabIndex={0}
				aria-label="Click to place an annotation pin"
				className="absolute inset-0 z-10 cursor-crosshair focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				onClick={handleOverlayClick}
				onKeyDown={handleOverlayKeyDown}
			/>

			{/* Numbered pins — z-20 sits above the overlay so clicks on pins don't create new ones */}
			{annotations.map((a) => (
				<Popover
					key={a.id}
					open={openPinId === a.id}
					onOpenChange={(open) => {
						if (!open) setOpenPinId(null)
					}}
				>
					<PopoverTrigger asChild>
						<button
							type="button"
							aria-label={`Annotation ${a.pinNumber}`}
							className={cn(
								'absolute z-20 -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-accent text-accent-foreground text-xs font-bold flex items-center justify-center shadow-md cursor-pointer transition-shadow',
								openPinId === a.id && 'ring-2 ring-ring ring-offset-1',
							)}
							style={{ left: `${a.position.x * 100}%`, top: `${a.position.y * 100}%` }}
							onClick={(e) => {
								e.stopPropagation()
								openPin(a.id, a.comment)
							}}
						>
							{a.pinNumber}
						</button>
					</PopoverTrigger>
					<PopoverContent
						className="w-72 p-3 space-y-2"
						align="start"
						// Stop clicks inside the popover from bubbling to the overlay
						onClick={(e) => e.stopPropagation()}
					>
						{a.selector && (
							<p className="text-xs text-muted-foreground font-mono truncate">{a.selector}</p>
						)}
						<textarea
							className="w-full rounded-md border border-input bg-background p-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
							rows={3}
							placeholder="Add a comment…"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
						/>
						<div className="flex justify-between">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="text-destructive hover:text-destructive gap-1"
								onClick={() => removeAnnotation(a.id)}
							>
								<X size={14} />
								Remove
							</Button>
							<Button type="button" size="sm" className="gap-1" onClick={() => saveComment(a.id)}>
								<Check size={14} />
								Save
							</Button>
						</div>
					</PopoverContent>
				</Popover>
			))}
		</div>
	)
}
