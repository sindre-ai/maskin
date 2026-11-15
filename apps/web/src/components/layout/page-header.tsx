import type { NewMenuPrimaryOverride } from '@/components/shared/new-menu'
import { type PageGutter, type PageHeaderCrumb, usePageHeader } from '@/lib/page-header-context'
import { useEffect } from 'react'

export function PageHeader({
	title,
	subtitle,
	actions,
	leadingActions,
	titleTabs,
	stickyIdentity,
	crumb,
	contentPush,
	scrollLocked,
	newMenuPrimaryOverride,
	newMenuDisabled,
	hideTitle,
	wrapActions,
	hideBar,
	gutter,
}: {
	// Rendered by the shared top nav as the screen's <h1>, not inline here —
	// v2 has exactly one title per screen and it lives in the nav row.
	title?: string
	// Muted count or context that sits beside the title in the nav row.
	subtitle?: string
	actions?: React.ReactNode
	// Like `actions`, but rendered before the workspace search rather than after it.
	leadingActions?: React.ReactNode
	// Controls that sit beside the <h1> in the nav row's left cluster instead
	// of out by search and New — see PageHeaderContext.
	titleTabs?: React.ReactNode
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
	// Swaps the label/action on the primary half of the shared New split-button
	// while the page is mounted. The chevron menu is left unchanged. Used by
	// object detail to run the D4 "✎ Answer this ask" verb swap when a pending
	// ask targets the reader.
	newMenuPrimaryOverride?: NewMenuPrimaryOverride
	// Dims both halves of the shared New split-button at 60% opacity while the
	// page is mounted (D4 read-only rule).
	newMenuDisabled?: boolean
	// Hides only the rendered <h1> in the shared nav row, for a two-pane page
	// that draws its own title. `title` is still published, so the crumb chain
	// and document title keep working.
	hideTitle?: boolean
	// Below md, lets the buttons drop to a second line rather than the title shrinking to fit
	// beside them — see PageHeaderContext.
	wrapActions?: boolean
	// From md the shared bar draws nothing (no title, no New button) — for a page that owns
	// its whole top edge, as Chats does. Below md the bar still renders.
	hideBar?: boolean
	// 'wide' widens the side padding from 28px to 48px from `lg:` (For you).
	gutter?: PageGutter
}) {
	const {
		setTitle,
		setSubtitle,
		setActions,
		setLeadingActions,
		setTitleTabs,
		setStickyIdentity,
		setCrumb,
		setContentPush,
		setScrollLocked,
		setNewMenuPrimaryOverride,
		setNewMenuDisabled,
		setHideTitle,
		setWrapActions,
		setHideBar,
		setGutter,
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
		setLeadingActions(leadingActions ?? null)
		return () => setLeadingActions(null)
	}, [leadingActions, setLeadingActions])

	useEffect(() => {
		setTitleTabs(titleTabs ?? null)
		return () => setTitleTabs(null)
	}, [titleTabs, setTitleTabs])

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

	useEffect(() => {
		setNewMenuPrimaryOverride(newMenuPrimaryOverride)
		return () => setNewMenuPrimaryOverride(undefined)
	}, [newMenuPrimaryOverride, setNewMenuPrimaryOverride])

	useEffect(() => {
		setNewMenuDisabled(newMenuDisabled)
		return () => setNewMenuDisabled(undefined)
	}, [newMenuDisabled, setNewMenuDisabled])

	useEffect(() => {
		setHideTitle(hideTitle)
		return () => setHideTitle(undefined)
	}, [hideTitle, setHideTitle])

	useEffect(() => {
		setWrapActions(wrapActions)
		return () => setWrapActions(undefined)
	}, [wrapActions, setWrapActions])

	useEffect(() => {
		setHideBar(hideBar)
		return () => setHideBar(undefined)
	}, [hideBar, setHideBar])

	useEffect(() => {
		setGutter(gutter)
		return () => setGutter(undefined)
	}, [gutter, setGutter])

	// The title is published to the nav row above; nothing renders in the page body.
	return null
}
