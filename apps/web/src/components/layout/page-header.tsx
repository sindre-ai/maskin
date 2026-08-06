import { usePageHeader } from '@/lib/page-header-context'
import { useEffect } from 'react'

export function PageHeader({
	actions,
	stickyIdentity,
	contentPush,
}: {
	title?: string
	actions?: React.ReactNode
	stickyIdentity?: React.ReactNode
	// CSS width value the app shell should be pushed left by while this page
	// is mounted — see PageHeaderContext.
	contentPush?: string
}) {
	const { setActions, setStickyIdentity, setContentPush } = usePageHeader()

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

	return null
}
