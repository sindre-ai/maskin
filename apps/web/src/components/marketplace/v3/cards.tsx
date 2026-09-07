/**
 * Card variants for the Marketplace v3 bands:
 *   RecommendedCard — indigo WHY-block + integration pill + Install
 *   LoopCard        — IN/OUT step-flow + amber Asks-you chip + Manage-row when installed
 *   CompactCard     — icon + name + type chip + one-line outcome + Install / Installed
 *
 * Cards themselves are not clickable (design spec §Out-of-scope) — only the
 * explicit Install and Details buttons are.
 */

import type { CatalogItemCard } from './catalog'

interface CardHandlers {
	onInstall: (item: CatalogItemCard) => void
}

// ————— Recommended card —————

export function RecommendedCard({ item, onInstall }: { item: CatalogItemCard } & CardHandlers) {
	return (
		<div className="mp-rec-card">
			<div className="head">
				<div className="mp-icon-tile" data-brand={item.brand}>
					{iconGlyph(item)}
				</div>
				<div>
					<div className="name">{item.display_name}</div>
					<span className="mp-type-chip" data-kind={item.item_kind}>
						{typeChipLabel(item.item_kind)}
					</span>
				</div>
			</div>
			{item.why_line ? (
				<div className="mp-why">
					<SparkleIcon />
					<span>{item.why_line}</span>
				</div>
			) : null}
			<div className="mp-row-end">
				<span
					className={`mp-needs${item.requires_status === 'ready' ? ' connected' : ''}`}
				>
					<span className="dot" />
					{item.requires_label ?? (item.requires_status === 'ready' ? 'Ready' : 'Needs setup')}
				</span>
				<button
					type="button"
					className="mp-btn mp-btn-primary mp-btn-sm"
					aria-label={`Install ${item.display_name}`}
					onClick={() => onInstall(item)}
				>
					Install
				</button>
			</div>
		</div>
	)
}

// ————— Loop card (rich) —————

export function LoopCard({ item, onInstall }: { item: CatalogItemCard } & CardHandlers) {
	const summary = item.loop_summary
	const installed = Boolean(item.installed_installation_id)
	return (
		<div className="mp-loop-card">
			<div className="head">
				<div className="mp-icon-tile" data-brand={item.brand}>
					❏
				</div>
				<div>
					{item.eyebrow ? <div className="use">{item.eyebrow}</div> : null}
					<div className="title">{item.display_name}</div>
				</div>
			</div>
			{item.description ? <div className="desc">{item.description}</div> : null}
			{summary ? (
				<div className="mp-step-flow" aria-label="Loop steps">
					{summary.ins.map((line, i) => (
						<div className="mp-step-row" key={`in-${i}`}>
							<span className="kind in">IN</span>
							<span className="text">{renderStepText(line)}</span>
						</div>
					))}
					{summary.outs.map((line, i) => (
						<div className="mp-step-row" key={`out-${i}`}>
							<span className="kind out">OUT</span>
							<span className="text">{renderStepText(line)}</span>
						</div>
					))}
				</div>
			) : null}
			<div className="mp-meta-row">
				{typeof item.asks_per_cycle === 'number' ? (
					<span className="mp-asks">Asks you {item.asks_per_cycle}× per cycle</span>
				) : null}
				<span
					className={`mp-needs${item.requires_status === 'ready' ? ' connected' : ''}`}
				>
					<span className="dot" />
					{item.requires_label ?? ''}
				</span>
			</div>
			{installed ? (
				<div className="mp-manage-row" role="group" aria-label={`${item.display_name}, installed`}>
					<div>
						<span className="stat">
							<b>{item.installed_stats?.cycles_this_week ?? 0}</b> cycles this week
						</span>
						<span className="stat">
							<b>{item.installed_stats?.asks_pending ?? 0}</b> asks pending
						</span>
					</div>
					<div style={{ display: 'flex', gap: 6 }}>
						<button type="button" className="mp-btn mp-btn-secondary mp-btn-sm">
							Open loop
						</button>
						<button
							type="button"
							className="mp-btn mp-btn-ghost mp-btn-sm"
							aria-haspopup="menu"
						>
							Manage ▾
						</button>
					</div>
				</div>
			) : (
				<div className="mp-row-end">
					<button type="button" className="mp-btn mp-btn-secondary mp-btn-sm">
						Details
					</button>
					<button
						type="button"
						className="mp-btn mp-btn-primary"
						aria-label={`Install ${item.display_name}`}
						onClick={() => onInstall(item)}
					>
						Install
					</button>
				</div>
			)}
		</div>
	)
}

// ————— Compact card (agent / skill / tool) —————

export function CompactCard({ item, onInstall }: { item: CatalogItemCard } & CardHandlers) {
	const installed = Boolean(item.installed_installation_id)
	return (
		<div className="mp-compact-card">
			<div className="head">
				<div className="mp-icon-tile" data-brand={item.brand ?? item.item_kind}>
					{iconGlyph(item)}
				</div>
				<div>
					<div className="name">{item.display_name}</div>
					<span className="mp-type-chip" data-kind={item.item_kind}>
						{typeChipLabel(item.item_kind)}
					</span>
				</div>
			</div>
			<div className="outcome">{item.outcome_line}</div>
			<div className="mp-row-end" style={{ justifyContent: 'flex-end' }}>
				{installed ? (
					<span className="mp-installed" aria-label={`${item.display_name}, installed`}>
						<CheckIcon />
						Installed
					</span>
				) : (
					<button
						type="button"
						className="mp-btn mp-btn-primary mp-btn-sm"
						aria-label={`Install ${item.display_name}`}
						onClick={() => onInstall(item)}
					>
						Install
					</button>
				)}
			</div>
		</div>
	)
}

// ————— Icons + helpers —————

function typeChipLabel(kind: CatalogItemCard['item_kind']): string {
	switch (kind) {
		case 'loop':
			return 'LOOP'
		case 'agent':
			return 'AGENT'
		case 'skill':
			return 'SKILL'
		case 'mcp_server':
			return 'MCP SERVER'
	}
}

function iconGlyph(item: CatalogItemCard): string {
	if (item.brand === 'slack') return '#'
	if (item.brand === 'stripe') return '$'
	if (item.brand === 'intercom') return 'I'
	if (item.brand === 'linear') return 'L'
	if (item.brand === 'salesforce') return 'S'
	if (item.brand === 'granola') return 'G'
	if (item.item_kind === 'loop') return '❏'
	return item.display_name.trim().charAt(0).toUpperCase()
}

// A step line may embed *asterisk-bolded* fragments per the design spec seed
// strings. Render them as inline <b> so the visual weight matches the
// prototype without needing a full markdown parser.
function renderStepText(line: string) {
	const parts = line.split(/(\*[^*]+\*)/g).filter(Boolean)
	return parts.map((part, i) => {
		if (part.startsWith('*') && part.endsWith('*')) {
			return <b key={i}>{part.slice(1, -1)}</b>
		}
		return <span key={i}>{part}</span>
	})
}

function SparkleIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
			<path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
		</svg>
	)
}
function CheckIcon() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
			<path d="M4 12l5 5L20 6" />
		</svg>
	)
}
