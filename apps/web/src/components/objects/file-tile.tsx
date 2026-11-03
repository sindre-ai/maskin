import { cn } from '@/lib/cn'
import {
	Code as CodeIcon,
	File as FileIcon,
	FileImage,
	FileText,
	FileType,
	Globe,
} from 'lucide-react'

/** Per-mime tinted 32×32 (sm=24×24) square with a lucide glyph. Carries
 *  `aria-hidden` so the accessible name comes from the filename to its right,
 *  per Designer §7 accessibility. Palette is drawn from the existing v2
 *  zinc + accent tokens: md=cyan, html=indigo, img=fuchsia, pdf=red,
 *  code=emerald; unknown types fall back to muted. */
export function MimeTile({
	mimeType,
	size = 'md',
	className,
}: {
	mimeType: string
	size?: 'sm' | 'md'
	className?: string
}) {
	const { bg, text, Icon } = mimeStyle(mimeType)
	return (
		<span
			aria-hidden="true"
			className={cn(
				'grid shrink-0 place-items-center rounded-lg',
				size === 'md' ? 'size-8' : 'size-6',
				bg,
				text,
				className,
			)}
		>
			<Icon className={size === 'md' ? 'size-4' : 'size-3.5'} />
		</span>
	)
}

function mimeStyle(mimeType: string) {
	const m = (mimeType ?? '').toLowerCase()
	if (m.includes('markdown') || m === 'text/markdown' || m.endsWith('/md')) {
		return {
			bg: 'bg-cyan-50 dark:bg-cyan-950/40',
			text: 'text-cyan-700 dark:text-cyan-300',
			Icon: FileText,
		}
	}
	if (m.includes('html')) {
		return {
			bg: 'bg-indigo-50 dark:bg-indigo-950/40',
			text: 'text-indigo-700 dark:text-indigo-300',
			Icon: Globe,
		}
	}
	if (m.startsWith('image/')) {
		return {
			bg: 'bg-fuchsia-50 dark:bg-fuchsia-950/40',
			text: 'text-fuchsia-700 dark:text-fuchsia-300',
			Icon: FileImage,
		}
	}
	if (m === 'application/pdf' || m.endsWith('/pdf')) {
		return {
			bg: 'bg-red-50 dark:bg-red-950/40',
			text: 'text-red-700 dark:text-red-300',
			Icon: FileType,
		}
	}
	if (
		m.startsWith('text/') ||
		m.includes('javascript') ||
		m.includes('typescript') ||
		m.includes('json') ||
		m.includes('code')
	) {
		return {
			bg: 'bg-emerald-50 dark:bg-emerald-950/40',
			text: 'text-emerald-700 dark:text-emerald-300',
			Icon: CodeIcon,
		}
	}
	return { bg: 'bg-muted', text: 'text-muted-foreground', Icon: FileIcon }
}

/** Human-friendly byte formatter — matches the `12 KB` / `1.4 MB` reading
 *  Designer spec §4 targets for the FileRow meta line. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
	const units = ['B', 'KB', 'MB', 'GB']
	let n = bytes
	let u = 0
	while (n >= 1024 && u < units.length - 1) {
		n /= 1024
		u++
	}
	const rounded = n >= 100 || u === 0 ? Math.round(n) : Math.round(n * 10) / 10
	return `${rounded} ${units[u]}`
}
