import { usePageHeader } from '@/lib/page-header-context'
import { useEffect } from 'react'

export function PageHeader({
	title,
	actions,
	stickyIdentity,
	contentPush,
	scrollLocked,
}: {
	title?: string
	actions?: React.ReactNode
	stickyIdentity?: React.ReactNode
	// CSS width value the app shell should be pushed left by while this page
	// is mounted — see PageHeaderContext.
	contentPush?: string
	// True while this page wants the shared page scroll container to stop
	// scrolling itself, in favor of an internal scroll region it owns — see
	// PageHeaderContext.
	scrollLocked?: boolean
}) {
	const { setActions, setStickyIdentity, setContentPush, setScrollLocked } = usePageHeader()

	useEffect(() => {
		setActions(actions ?? null)
		return () => setActions(null)
	}, [actions, setActions])

	useEffect(() => {
		setStickyIdentity(stickyIdentity ?? null)
		return () => setStickyIdentity(null)
	}, [stickyIdentity, setStickyIdentity])

	useEffect(() => {
		setContentPush(contentPush)
		return () => setContentPush(undefined)
	}, [contentPush, setContentPush])

	useEffect(() => {
		setScrollLocked(scrollLocked ?? false)
		return () => setScrollLocked(false)
	}, [scrollLocked, setScrollLocked])

	if (!title) return null

	return <h1 className="mb-4 text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
}
