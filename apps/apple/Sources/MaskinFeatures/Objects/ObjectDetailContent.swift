import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The scrolling body of an object: header, the decision slot, description, properties,
/// relationships and the activity timeline. Stateless apart from the store it reads, so it
/// renders in snapshots; the screen adds the toolbar, composer and navigation around it.
struct ObjectDetailContent<Decision: View>: View {
	let store: ObjectDetailStore
	var onOpenObject: ((String) -> Void)?
	var onEdit: () -> Void = {}
	@ViewBuilder var decision: () -> Decision

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s10) {
			if let message = store.actionError {
				FormError(message).onTapGesture { store.clearActionError() }
			}
			if store.isOffline { OfflineBanner() }
			if let object = store.object {
				header(object)
				decision()
				if let content = object.content, !content.isEmpty {
					card { MarkdownContent(content) }
				}
				properties(object)
				if !store.links.isEmpty { relationships }
				timeline
			} else {
				switch store.phase {
				case .gone:
					EmptyState(
						symbol: "trash", title: "This object was deleted",
						message: "It's no longer in the workspace.")
				case .failed(let message):
					EmptyState(
						symbol: "exclamationmark.triangle", title: "Couldn't load this object", message: message
					) {
						Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
					}
				default:
					LoadingSkeleton(rows: 2)
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	// MARK: Header

	private func header(_ object: WorkObject) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			HStack(spacing: MaskinSpace.s4) {
				TypeBadge(object.type, label: store.directory.typeName(object.type))
				statusMenu(object)
				Spacer()
			}
			Text(object.displayTitle)
				.maskinText(.title)
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, alignment: .leading)
				.fixedSize(horizontal: false, vertical: true)
			HStack(spacing: MaskinSpace.s4) {
				if let owner = store.ownerName {
					ActorAvatar(
						name: owner, kind: store.directory.actor(for: object.driverId)?.isAgent == true ? .agent : .human,
						size: MaskinSpace.s11)
					Text(owner).foregroundStyle(MaskinColor.ink2)
				} else {
					Text("No owner").foregroundStyle(MaskinColor.ink5)
				}
				if object.updatedAt != nil {
					Text("·").foregroundStyle(MaskinColor.ink5)
					HStack(spacing: MaskinSpace.s2) {
						Text("Updated")
						RelativeTime(object.updatedAt)
					}
					.foregroundStyle(MaskinColor.ink4)
				}
			}
			.maskinText(.subhead)
			if let activity = object.activeActivity, !activity.isEmpty {
				Label(activity, systemImage: "sparkles")
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.accentFgStrong)
					.padding(.horizontal, MaskinSpace.s7)
					.padding(.vertical, MaskinSpace.s5)
					.background(MaskinColor.accentTint2, in: Capsule())
			}
		}
	}

	private func statusMenu(_ object: WorkObject) -> some View {
		Menu {
			ForEach(store.statusOptions, id: \.self) { status in
				Button {
					Task { await store.setStatus(status) }
				} label: {
					if status == object.status {
						Label(MaskinStatus.label(for: status), systemImage: "checkmark")
					} else {
						Text(MaskinStatus.label(for: status))
					}
				}
			}
		} label: {
			HStack(spacing: MaskinSpace.s2) {
				StatusBadge(object.status)
				Image(systemName: "chevron.up.chevron.down")
					.font(.system(size: MaskinFontSize.t11))
					.foregroundStyle(MaskinColor.ink5)
			}
		}
		.accessibilityLabel("Status \(MaskinStatus.label(for: object.status)). Change status")
	}

	// MARK: Sections

	@ViewBuilder private func properties(_ object: WorkObject) -> some View {
		let rows = object.metadata.sorted { $0.key < $1.key }
		if !rows.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				SectionHeader("Properties")
				card {
					VStack(spacing: MaskinSpace.s6) {
						ForEach(rows, id: \.key) { row in
							HStack(alignment: .firstTextBaseline) {
								Text(row.key.replacingOccurrences(of: "_", with: " ").capitalized)
									.foregroundStyle(MaskinColor.ink4)
								Spacer(minLength: MaskinSpace.s7)
								Text(row.value).foregroundStyle(MaskinColor.ink).multilineTextAlignment(.trailing)
							}
							.maskinText(.subhead)
						}
					}
				}
			}
		}
	}

	private var relationships: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader("Related") {
				Text("\(store.links.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			VStack(spacing: 0) {
				ForEach(Array(store.links.enumerated()), id: \.element.id) { index, link in
					if index > 0 { Divider().overlay(MaskinSurface.separator) }
					linkRow(link)
				}
			}
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		}
	}

	@ViewBuilder private func linkRow(_ link: ObjectLink) -> some View {
		let label = HStack(spacing: MaskinSpace.s7) {
			TypeBadge(link.otherType, style: .tile)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				MonoLabel(link.phrase)
				Text(link.otherTitle)
					.maskinText(.body)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2)
					.multilineTextAlignment(.leading)
			}
			Spacer(minLength: MaskinSpace.s4)
			if let status = link.otherStatus { StatusBadge(status, style: .word) }
			if onOpenObject != nil {
				Image(systemName: "chevron.right")
					.font(.system(size: MaskinFontSize.t13, weight: .semibold))
					.foregroundStyle(MaskinColor.ink5)
			}
		}
		.padding(MaskinSpace.s8)
		.contentShape(Rectangle())
		if let onOpenObject {
			Button { onOpenObject(link.otherId) } label: { label }.buttonStyle(.plain)
		} else {
			label
		}
	}

	private var timeline: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			SectionHeader("Activity") {
				Text("\(store.timeline.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			if store.timeline.isEmpty {
				Text("No activity yet. Start the conversation below.")
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink4)
			}
			ForEach(store.timeline) { item in
				TimelineRow(
					item: item, name: store.authorName(for: item), isAgent: store.isAgent(item),
					retry: { Task { await store.retryComment(item.id) } },
					discard: { store.discardComment(item.id) })
			}
		}
		.accessibilityElement(children: .contain)
	}

	private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
		content()
			.padding(MaskinSpace.s9)
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
	}
}

extension ObjectDetailContent where Decision == EmptyView {
	init(
		store: ObjectDetailStore, onOpenObject: ((String) -> Void)? = nil, onEdit: @escaping () -> Void = {}
	) {
		self.init(store: store, onOpenObject: onOpenObject, onEdit: onEdit) { EmptyView() }
	}
}

/// A comment or system event in the activity stream.
struct TimelineRow: View {
	let item: TimelineItem
	let name: String
	let isAgent: Bool
	var retry: () -> Void = {}
	var discard: () -> Void = {}

	var body: some View {
		switch item.kind {
		case .comment(let text):
			HStack(alignment: .top, spacing: MaskinSpace.s6) {
				ActorAvatar(name: name, kind: isAgent ? .agent : .human, size: MaskinSpace.s13)
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					HStack(spacing: MaskinSpace.s4) {
						Text(name).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
						if isAgent { MonoLabel("Agent", color: MaskinColor.ink5) }
						RelativeTime(item.date, style: .compact)
							.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
					}
					MarkdownContent(text)
						.padding(MaskinSpace.s7)
						.background(
							MaskinSurface.card,
							in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
						)
						.opacity(item.delivery == .sending ? 0.55 : 1)
					deliveryFooter
				}
			}
			.accessibilityElement(children: .contain)
		case .activity(let summary):
			HStack(spacing: MaskinSpace.s4) {
				Circle().fill(MaskinColor.ink5).frame(width: MaskinSpace.s2, height: MaskinSpace.s2)
					.padding(.horizontal, MaskinSpace.s5)
				Text(name).fontWeight(.medium).foregroundStyle(MaskinColor.ink3)
				Text(summary).foregroundStyle(MaskinColor.ink4)
				RelativeTime(item.date, style: .compact).foregroundStyle(MaskinColor.ink5)
			}
			.maskinText(.caption)
			.lineLimit(2)
			.accessibilityElement(children: .combine)
		}
	}

	@ViewBuilder private var deliveryFooter: some View {
		if item.delivery == .failed {
			HStack(spacing: MaskinSpace.s6) {
				Label("Not sent", systemImage: "exclamationmark.circle.fill")
					.foregroundStyle(MaskinColor.dangerStrong)
				Button("Retry", action: retry)
				Button("Discard", role: .destructive, action: discard)
			}
			.maskinText(.caption)
			.buttonStyle(.borderless)
		}
	}
}
