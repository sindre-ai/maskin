import { cn } from '@/lib/cn'
import { useState } from 'react'

/**
 * The 38px logo tile on an integration card. The company's site icon fills it; when
 * there is no domain, or the icon does not load, a letter tile stays in its place.
 */
export function ProviderLogo({
	name,
	domain,
	className,
}: {
	name: string
	domain?: string
	className?: string
}) {
	const [failed, setFailed] = useState(false)
	const showImage = Boolean(domain) && !failed
	return (
		<span
			aria-hidden="true"
			className={cn(
				'flex size-[38px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-muted text-[15px] font-bold text-foreground',
				className,
			)}
		>
			{showImage ? (
				<img
					src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain ?? '')}&sz=64`}
					alt=""
					width={24}
					height={24}
					className="size-6"
					onError={() => setFailed(true)}
				/>
			) : (
				name.trim().charAt(0).toUpperCase()
			)}
		</span>
	)
}
