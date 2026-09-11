/**
 * Install-modal family — 5 verbatim-copy variants from design spec §Copy:
 * needs-integration, needs-decision, installing, success, error. Shared
 * scrim/panel/focus-trap wrapper below.
 *
 * State machine: needs-integration / needs-decision → installing → success | error.
 * `installing` disables both cancel + primary (irrevocable). `error` guarantees
 * nothing changed in the workspace ("Nothing was changed in your workspace.").
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CatalogItemCard } from './catalog'
import { useInstallMarketplaceItem } from './catalog'

export type InstallModalVariant =
	| 'needs-integration'
	| 'needs-decision'
	| 'installing'
	| 'success'
	| 'error'

interface InstallModalProps {
	item: CatalogItemCard
	initialVariant: InstallModalVariant
	workspaceId: string
	onClose: () => void
	// Non-injected escape hatch for the design-fidelity check task — lets a
	// reviewer force a variant open without going through the flow.
	forcedVariant?: InstallModalVariant
}

export function InstallModal({
	item,
	initialVariant,
	workspaceId,
	onClose,
	forcedVariant,
}: InstallModalProps) {
	const [variant, setVariant] = useState<InstallModalVariant>(
		forcedVariant ?? initialVariant,
	)
	const [selectedTeam, setSelectedTeam] = useState<'customer' | 'revenue' | 'shared'>(
		'customer',
	)
	const install = useInstallMarketplaceItem(workspaceId)

	useEffect(() => {
		if (forcedVariant) setVariant(forcedVariant)
	}, [forcedVariant])

	const beginInstalling = useCallback(() => {
		setVariant('installing')
		install.mutate(
			{ item_kind: item.item_kind, catalog_id: item.catalog_id },
			{
				onSuccess: () => setVariant('success'),
				onError: () => setVariant('error'),
			},
		)
	}, [install, item])

	// Focus trap + Esc-to-close. When `installing`, Esc is still allowed —
	// the design spec says the modal is dismissable via Esc even mid-install
	// (only the buttons are disabled, not the sheet).
	const dialogRef = useRef<HTMLDivElement>(null)
	const openerRef = useRef<Element | null>(null)
	useEffect(() => {
		openerRef.current = document.activeElement
		const el = dialogRef.current
		if (!el) return
		const focusable = el.querySelectorAll<HTMLElement>(
			'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
		)
		focusable[0]?.focus()
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.preventDefault()
				onClose()
				return
			}
			if (e.key !== 'Tab') return
			const list = el.querySelectorAll<HTMLElement>(
				'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			)
			if (list.length === 0) return
			const first = list[0]
			const last = list[list.length - 1]
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault()
				last.focus()
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault()
				first.focus()
			}
		}
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('keydown', onKey)
			if (openerRef.current instanceof HTMLElement) openerRef.current.focus()
		}
	}, [onClose])

	const titleId = `mp-install-title-${item.catalog_id}`
	const brand = item.brand ?? undefined

	return (
		<div
			className="marketplace-v3-modal-scrim"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose()
			}}
		>
			<div
				ref={dialogRef}
				className="marketplace-v3-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
			>
				{variant === 'needs-integration' && (
					<NeedsIntegration
						item={item}
						titleId={titleId}
						brand={brand}
						onClose={onClose}
						onConnect={beginInstalling}
					/>
				)}
				{variant === 'needs-decision' && (
					<NeedsDecision
						item={item}
						titleId={titleId}
						selectedTeam={selectedTeam}
						onSelectTeam={setSelectedTeam}
						onClose={onClose}
						onConfirm={beginInstalling}
					/>
				)}
				{variant === 'installing' && (
					<Installing item={item} titleId={titleId} selectedTeam={selectedTeam} />
				)}
				{variant === 'success' && (
					<Success item={item} titleId={titleId} onClose={onClose} />
				)}
				{variant === 'error' && (
					<ErrorVariant
						item={item}
						titleId={titleId}
						onClose={onClose}
						onRetry={beginInstalling}
					/>
				)}
			</div>
		</div>
	)
}

// ————— Variant 1: needs-integration —————

function NeedsIntegration({
	item,
	titleId,
	brand,
	onClose,
	onConnect,
}: {
	item: CatalogItemCard
	titleId: string
	brand?: string
	onClose: () => void
	onConnect: () => void
}) {
	return (
		<>
			<div className="head">
				<div className="mp-icon-tile" data-brand={brand}>
					{brandInitial(item.display_name)}
				</div>
				<div>
					<h3 id={titleId} className="title">
						Install {item.display_name}
					</h3>
					<div className="subtitle">
						MCP server · adds meeting-notes tools to every agent in this workspace
					</div>
				</div>
				<button className="close" onClick={onClose} aria-label="Close">
					<CloseIcon />
				</button>
			</div>
			<div className="body">
				<div className="step-list">
					<div className="step-item active">
						<div className="step-badge">1</div>
						<div>
							<h4>Connect {item.display_name}</h4>
							<p>
								Grant Maskin read access to your {item.display_name} notebook. You control what
								stays private.
							</p>
						</div>
					</div>
					<div className="step-item">
						<div className="step-badge">2</div>
						<div>
							<h4>Confirm scope</h4>
							<p>Choose which notebooks agents can read.</p>
						</div>
					</div>
					<div className="step-item">
						<div className="step-badge">3</div>
						<div>
							<h4>Available in workspace</h4>
							<p>
								Every agent will be able to call {item.display_name} tools under its own
								guardrails.
							</p>
						</div>
					</div>
				</div>
				<div className="callout info">
					<InfoIcon />
					<div>
						Connections live on the <b>agent</b>, not here. You&apos;ll pick which agent uses
						this from that agent&apos;s page after install.
					</div>
				</div>
			</div>
			<div className="foot">
				<button className="mp-btn mp-btn-ghost" onClick={onClose}>
					Cancel
				</button>
				<button className="mp-btn mp-btn-primary" onClick={onConnect}>
					Connect {item.display_name} →
				</button>
			</div>
		</>
	)
}

// ————— Variant 2: needs-decision —————

function NeedsDecision({
	item,
	titleId,
	selectedTeam,
	onSelectTeam,
	onClose,
	onConfirm,
}: {
	item: CatalogItemCard
	titleId: string
	selectedTeam: 'customer' | 'revenue' | 'shared'
	onSelectTeam: (team: 'customer' | 'revenue' | 'shared') => void
	onClose: () => void
	onConfirm: () => void
}) {
	const teamLabel =
		selectedTeam === 'customer' ? 'Customer' : selectedTeam === 'revenue' ? 'Revenue' : 'Shared'
	return (
		<>
			<div className="head">
				<div className="mp-icon-tile">❏</div>
				<div>
					<h3 id={titleId} className="title">
						Install {item.display_name}
					</h3>
					<div className="subtitle">
						Choose which team owns this loop so its asks land in the right feed.
					</div>
				</div>
				<button className="close" onClick={onClose} aria-label="Close">
					<CloseIcon />
				</button>
			</div>
			<div className="body">
				<div className="form-block">
					<label id={`${titleId}-team`}>Assign to team</label>
					<div className="radio-list" role="radiogroup" aria-labelledby={`${titleId}-team`}>
						<TeamRadio
							value="customer"
							selected={selectedTeam === 'customer'}
							title="Customer"
							subtitle="Sentinel and Relay are already on this team."
							onSelect={() => onSelectTeam('customer')}
						/>
						<TeamRadio
							value="revenue"
							selected={selectedTeam === 'revenue'}
							title="Revenue"
							subtitle="Loop asks land in Revenue's For-You feed."
							onSelect={() => onSelectTeam('revenue')}
						/>
						<TeamRadio
							value="shared"
							selected={selectedTeam === 'shared'}
							title="Shared"
							subtitle="Available to everyone; nobody owns the asks."
							onSelect={() => onSelectTeam('shared')}
						/>
					</div>
					<div className="form-hint">You can change this later from the loop&apos;s page.</div>
				</div>
				<div className="callout">
					<WarnIcon />
					<div>
						Installing wires up <b>Sentinel</b>, <b>Forge</b>, 2 triggers, and reads from{' '}
						<b>PostHog</b>. Nothing writes to a customer without your sign-off.
					</div>
				</div>
			</div>
			<div className="foot">
				<button className="mp-btn mp-btn-ghost" onClick={onClose}>
					Cancel
				</button>
				<button className="mp-btn mp-btn-primary" onClick={onConfirm}>
					Install to {teamLabel} →
				</button>
			</div>
		</>
	)
}

function TeamRadio({
	value,
	selected,
	title,
	subtitle,
	onSelect,
}: {
	value: string
	selected: boolean
	title: string
	subtitle: string
	onSelect: () => void
}) {
	return (
		<button
			type="button"
			role="radio"
			aria-checked={selected}
			className="radio-row"
			data-value={value}
			onClick={onSelect}
		>
			<span className="rd" aria-hidden="true" />
			<div>
				<h4>{title}</h4>
				<p>{subtitle}</p>
			</div>
		</button>
	)
}

// ————— Variant 3: installing —————

function Installing({
	item,
	titleId,
	selectedTeam,
}: {
	item: CatalogItemCard
	titleId: string
	selectedTeam: string
}) {
	const teamLabel =
		selectedTeam === 'customer' ? 'Customer' : selectedTeam === 'revenue' ? 'Revenue' : 'Shared'
	return (
		<>
			<div className="head">
				<div className="mp-icon-tile">❏</div>
				<div>
					<h3 id={titleId} className="title">
						Installing {item.display_name}
					</h3>
					<div className="subtitle">One moment — wiring the agents into your workspace.</div>
				</div>
			</div>
			<div className="body">
				<div className="step-list" aria-live="polite">
					<div className="step-item done">
						<div className="step-badge">✓</div>
						<div>
							<h4>Team assigned</h4>
							<p>{teamLabel}</p>
						</div>
					</div>
					<div className="step-item active">
						<div className="step-badge">
							<span
								className="mp-spinner"
								style={{ width: 10, height: 10, borderWidth: 1.5, color: '#fff' }}
							/>
						</div>
						<div>
							<h4>Wiring agents</h4>
							<p>Sentinel, Forge — adding to workspace.</p>
						</div>
					</div>
					<div className="step-item">
						<div className="step-badge">3</div>
						<div>
							<h4>Registering triggers</h4>
							<p>2 triggers on PostHog usage events.</p>
						</div>
					</div>
					<div className="step-item">
						<div className="step-badge">4</div>
						<div>
							<h4>Ready</h4>
							<p>You&apos;ll see the first ask when a cycle fires.</p>
						</div>
					</div>
				</div>
			</div>
			<div className="foot">
				<button className="mp-btn mp-btn-ghost" disabled>
					Cancel
				</button>
				<button className="mp-btn mp-btn-primary mp-btn-loading" disabled>
					<span className="mp-spinner" />
					Installing…
				</button>
			</div>
		</>
	)
}

// ————— Variant 4: success —————

function Success({
	item,
	titleId,
	onClose,
}: {
	item: CatalogItemCard
	titleId: string
	onClose: () => void
}) {
	return (
		<>
			<div className="head">
				<div
					className="mp-icon-tile"
					style={{ background: 'var(--mp-green-bg)', color: 'var(--mp-green-dark)' }}
				>
					✓
				</div>
				<div>
					<h3 id={titleId} className="title">
						{item.display_name} is installed
					</h3>
					<div className="subtitle">
						Cycle 1 opens the next time PostHog reports a usage drop.
					</div>
				</div>
				<button className="close" onClick={onClose} aria-label="Close">
					<CloseIcon />
				</button>
			</div>
			<div className="body">
				<div className="callout success" role="status">
					<CheckIcon />
					<div>
						Sentinel and Forge are in your workspace. 2 triggers active. You&apos;ll get a
						For-You card when a cycle asks for you.
					</div>
				</div>
				<div className="form-block">
					<label>Next</label>
					<div className="form-hint">
						Open the loop to set the usage-drop threshold, or come back later — the defaults
						are safe.
					</div>
				</div>
			</div>
			<div className="foot">
				<button className="mp-btn mp-btn-ghost" onClick={onClose}>
					Later
				</button>
				<button className="mp-btn mp-btn-primary" onClick={onClose}>
					Open loop →
				</button>
			</div>
		</>
	)
}

// ————— Variant 5: error —————

function ErrorVariant({
	item,
	titleId,
	onClose,
	onRetry,
}: {
	item: CatalogItemCard
	titleId: string
	onClose: () => void
	onRetry: () => void
}) {
	return (
		<>
			<div className="head">
				<div
					className="mp-icon-tile"
					style={{ background: 'var(--mp-red-bg)', color: 'var(--mp-red)' }}
				>
					!
				</div>
				<div>
					<h3 id={titleId} className="title">
						Couldn&apos;t install {item.display_name}
					</h3>
					<div className="subtitle">Nothing was changed in your workspace.</div>
				</div>
				<button className="close" onClick={onClose} aria-label="Close">
					<CloseIcon />
				</button>
			</div>
			<div className="body">
				<div className="callout error" role="status">
					<InfoIcon />
					<div>
						<b>PostHog auth expired.</b> Reconnect PostHog on its integration page, then try
						again. If it keeps happening, ping #maskin-help.
					</div>
				</div>
			</div>
			<div className="foot">
				<button className="mp-btn mp-btn-ghost" onClick={onClose}>
					Cancel
				</button>
				<button className="mp-btn mp-btn-secondary" onClick={onClose}>
					Reconnect PostHog
				</button>
				<button className="mp-btn mp-btn-primary" onClick={onRetry}>
					Try again
				</button>
			</div>
		</>
	)
}

// ————— Icon glyphs (inline SVG — no dep on lucide since we're scoped) —————

function CloseIcon() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
			<path d="M6 6l12 12M18 6L6 18" />
		</svg>
	)
}
function InfoIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
			<circle cx="12" cy="12" r="9" />
			<path d="M12 8v4M12 16h.01" />
		</svg>
	)
}
function WarnIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
			<path d="M12 3l9 16H3z" />
			<path d="M12 10v4M12 17h.01" />
		</svg>
	)
}
function CheckIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
			<path d="M4 12l5 5L20 6" />
		</svg>
	)
}

function brandInitial(name: string): string {
	return name.trim().charAt(0).toUpperCase()
}
