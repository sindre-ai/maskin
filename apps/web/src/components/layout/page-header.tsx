import { type PageHeaderCrumb, usePageHeader } from '@/lib/page-header-context'
import { useEffect } from 'react'

export function PageHeader({
	title,
	subtitle,
	actions,
	stickyIdentity,
	crumb,
	contentPush,
	scrollLocked,
}: {
	// Rendered by the shared top nav as the screen's <h1>, not inline here —
	// v2 has exactly one title per screen and it lives in the nav row.
	title?: string
	// Muted count or context that sits beside the title in the nav row.
	subtitle?: string
	actions?: React.ReactNode
	stickyIdentity?: React.ReactNode
	// A detail screen's own `Parent › Name` crumb. Publishing one collapses the
	// shared nav to the compact detail bar the mockup draws above the document.
	crumb?: PageHeaderCrumb
	// CSS width value the app shell should be pushed left by while this page
	// is mounted — see PageHeaderContext.
	contentPush?: string
	// True while this page wants the shared page scroll container to stop
	// scrolling itself, in favor of an internal scroll region it owns — see
	// PageHeaderContext.
	scrollLocked?: boolean
}) {
	const {
		setTitle,
		setSubtitle,
		setActions,
		setStickyIdentity,
		setCrumb,
		setContentPush,
		setScrollLocked,
	} = usePageHeader()

	useEffect(() => {
		setTitle(title)
		return () => setTitle(undefined)
	}, [title, setTitle])

	useEffect(() => {
		setSubtitle(subtitle)
		return () => setSubtitle(undefined)
	}, [subtitle, setSubtitle])

	useEffect(() => {
		setActions(actions ?? null)
		return () => setActions(null)
	}, [actions, setActions])

	useEffect(() => {
		setStickyIdentity(stickyIdentity ?? null)
		return () => setStickyIdentity(null)
	}, [stickyIdentity, setStickyIdentity])

	useEffect(() => {
		setCrumb(crumb)
		return () => setCrumb(undefined)
	}, [crumb, setCrumb])

	useEffect(() => {
		setContentPush(contentPush)
		return () => setContentPush(undefined)
	}, [contentPush, setContentPush])

	useEffect(() => {
		setScrollLocked(scrollLocked ?? false)
		return () => setScrollLocked(false)
	}, [scrollLocked, setScrollLocked])

	// The title is published to the nav row above; nothing renders in the page body.
	return null
}
