import { useEffect } from 'react'

// SPA-only: mutates the live <head> in an effect. Google renders JS before
// snapshotting, so this is enough to give unauthenticated routes distinct
// titles + descriptions in SERPs without pulling in SSR or a helmet library.
export function useDocumentHead({
	title,
	description,
}: {
	title: string
	description: string
}) {
	useEffect(() => {
		const previousTitle = document.title
		document.title = title

		let meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]')
		let metaCreated = false
		if (!meta) {
			meta = document.createElement('meta')
			meta.setAttribute('name', 'description')
			document.head.appendChild(meta)
			metaCreated = true
		}
		const previousDescription = meta.getAttribute('content') ?? ''
		meta.setAttribute('content', description)

		return () => {
			document.title = previousTitle
			if (metaCreated) {
				meta.remove()
			} else {
				meta.setAttribute('content', previousDescription)
			}
		}
	}, [title, description])
}
