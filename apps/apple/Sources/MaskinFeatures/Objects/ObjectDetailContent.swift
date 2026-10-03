import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The pages of an object's detail screen.
enum ObjectDetailPart: String, CaseIterable, Identifiable {
	/// Everything in one column (snapshots, previews).
	case all
	/// The pinned header above the pager.
	case header
	case overview, related, activity
	var id: String { rawValue }
}

/// The body of an object: header, the decision slot, description, properties, relationships and
/// the activity timeline. `part` picks which of them to render, so the screen can pin the header
/// and give each page its own scroll view. Stateless apart from the store it reads, so it renders
/// in snapshots; the screen adds the toolbar, composer and navigation around it.
struct ObjectDetailContent<Decision: View>: View {
	let store: ObjectDetailStore
	var part: ObjectDetailPart = .all
	var onOpenObject: ((String) -> Void)?
	var onEdit: () -> Void = {}
	@ViewBuilder var decision: () -> Decision
	@State private var showAllProperties = false
	@State private var descriptionExpanded = false
	@State private var expandedRuns: Set<String> = []

	private static var propertyPreview: Int { 4 }
	/// Moving an object into one of these means the agents take it from here: a bigger flourish.
	private static var handsOffStatuses: Set<String> { ["active", "in_progress"] }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s10) {
			if part == .all || part == .header {
				if let message = store.actionError {
					FormError(message).onTapGesture { store.clearActionError() }
				}
				if store.isOffline { OfflineBanner() }
			}
			if let object = store.object {
				switch part {
				case .all:
					header(object)
					decision()
					description(object)
					properties(object)
					if !store.links.isEmpty { relationships }
					timeline
				case .header: header(object)
				case .overview:
					header(object)
					decision()
					description(object)
					properties(object)
				case .related: relationships
				case .activity: timeline
				}
			} else if part == .all {
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

	/// Title first, then the object's properties as large, tappable pills (a phone-sized hit area,
	/// legible text) rather than the small badges a desktop row would use.
	private func header(_ object: WorkObject) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			Text(object.displayTitle)
				.maskinText(.title)
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, alignment: .leading)
								.fixedSize(horizontal: false, vertical: true)
			ChipFlow(spacing: MaskinSpace.s4) {
				statusMenu(object)
				ownerPill
				typePill(object)
			}
			if object.updatedAt != nil {
				HStack(spacing: MaskinSpace.s2) {
					Text("Updated")
					RelativeTime(object.updatedAt)
				}
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink4)
			}
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
		let colors = MaskinStatus.colors(for: object.status)
		return Menu {
			ForEach(store.statusOptions, id: \.self) { status in
				Button {
					MaskinHaptics.play(.selection)
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
			PropertyPill(fill: colors.bg) {
				Circle().fill(colors.fg).frame(width: MaskinSpace.s4, height: MaskinSpace.s4)
				Text(MaskinStatus.label(for: object.status)).foregroundStyle(colors.fg)
				Image(systemName: "chevron.up.chevron.down")
					.font(.system(size: MaskinFontSize.t11, weight: .semibold))
					.foregroundStyle(colors.fg.opacity(0.7))
			}
			.background {
				StatusBurst(
					trigger: object.status, color: colors.fg, sparks: Self.handsOffStatuses.contains(object.status))
			}
		}
		.accessibilityLabel("Status \(MaskinStatus.label(for: object.status)). Change status")
	}

	@ViewBuilder private var ownerPill: some View {
		if let owner = store.ownerName {
			let isAgent = store.directory.actor(for: store.object?.driverId)?.isAgent == true
			PropertyPill {
				ActorAvatar(name: owner, kind: isAgent ? .agent : .human, size: MaskinSpace.s12)
				Text(owner).foregroundStyle(MaskinColor.ink)
			}
			.accessibilityElement(children: .combine)
			.accessibilityLabel("Driver \(owner)")
		}
	}

	private func typePill(_ object: WorkObject) -> some View {
		let colors = MaskinObjectType.colors(for: object.type)
		return PropertyPill(fill: colors.bg) {
			if let symbol = MaskinObjectType.symbol(for: object.type) {
				Image(systemName: symbol)
					.font(.system(size: MaskinFontSize.t13, weight: .semibold))
					.foregroundStyle(colors.fg)
			}
			Text(store.directory.typeName(object.type)).foregroundStyle(colors.fg)
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel("Type \(store.directory.typeName(object.type))")
	}

	// MARK: Sections

	/// Long descriptions fold so they don't push the decision and properties off screen.
	@ViewBuilder private func description(_ object: WorkObject) -> some View {
		if let content = object.content, !content.isEmpty {
			let long = content.count > 1600
			card {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					MarkdownContent(content)
						.frame(maxHeight: long && !descriptionExpanded ? 560 : nil, alignment: .top)
						.clipped()
						.mask(alignment: .top) {
							if long && !descriptionExpanded {
								LinearGradient(
									colors: [.black, .black, .clear], startPoint: .top, endPoint: .bottom)
							} else {
								Color.black
							}
						}
					if long {
						Button(descriptionExpanded ? "Show less" : "Show more") {
							withAnimation(MaskinMotion.standard) { descriptionExpanded.toggle() }
						}
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.accentFgStrong)
					}
				}
			}
		}
	}

	/// Internal keys (leading underscore, bookkeeping like `previous_status`) stay hidden, and an
	/// actor id reads as the person's or agent's name, never the id.
	private func visibleProperties(_ object: WorkObject) -> [(key: String, value: String)] {
		object.metadata
			.filter { !$0.key.hasPrefix("_") && $0.key != "previous_status" && !$0.value.isEmpty }
			.sorted { $0.key < $1.key }
			.map { ($0.key, store.directory.name(for: $0.value) ?? $0.value) }
	}

	@ViewBuilder private func properties(_ object: WorkObject) -> some View {
		let all = visibleProperties(object)
		let rows = showAllProperties ? all : Array(all.prefix(Self.propertyPreview))
		if !all.isEmpty {
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
						if all.count > Self.propertyPreview {
							Button(showAllProperties ? "Show fewer" : "Show all \(all.count)") {
								withAnimation(MaskinMotion.standard) { showAllProperties.toggle() }
							}
							.maskinText(.subhead)
							.foregroundStyle(MaskinColor.accentFgStrong)
							.frame(maxWidth: .infinity, alignment: .leading)
						}
					}
				}
			}
		}
	}

	@ViewBuilder private var relationships: some View {
		if store.links.isEmpty {
			if part == .related {
				if store.hasFetched {
					EmptyState(
						symbol: "link", title: "Nothing related yet",
						message: "Objects this one blocks, informs or depends on show up here.")
				} else {
					LoadingSkeleton(rows: 2)
				}
			}
		} else {
			relationshipList
		}
	}

	/// Links grouped by what they mean ("Blocks", "Informs"…), in the order first seen.
	private var linkGroups: [(phrase: String, links: [ObjectLink])] {
		var order: [String] = []
		var buckets: [String: [ObjectLink]] = [:]
		for link in store.links {
			if buckets[link.phrase] == nil { order.append(link.phrase) }
			buckets[link.phrase, default: []].append(link)
		}
		return order.map { ($0, buckets[$0] ?? []) }
	}

	private var relationshipList: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s8) {
			if part != .related {
				SectionHeader("Related") {
					Text("\(store.links.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
				}
			}
			ForEach(linkGroups, id: \.phrase) { group in
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					HStack(spacing: MaskinSpace.s3) {
						MonoLabel(group.phrase)
						Text("\(group.links.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink5)
					}
					.accessibilityElement(children: .combine)
					.accessibilityAddTraits(.isHeader)
					VStack(spacing: 0) {
						ForEach(Array(group.links.enumerated()), id: \.element.id) { index, link in
							if index > 0 { Divider().overlay(MaskinSurface.separator) }
							linkRow(link)
						}
					}
					.background(
						MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
				}
			}
		}
	}

	@ViewBuilder private func linkRow(_ link: ObjectLink) -> some View {
		let label = HStack(spacing: MaskinSpace.s7) {
			TypeBadge(link.otherType, style: .tile)
			Text(link.otherTitle)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(2)
				.multilineTextAlignment(.leading)
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
			if part != .activity {
				SectionHeader("Activity") {
					Text("\(store.timeline.count)").maskinText(.mono).foregroundStyle(MaskinColor.ink4)
				}
			}
			if store.timeline.isEmpty {
				if store.hasFetched {
					Text("No activity yet. Start the conversation below.")
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
				} else {
					LoadingSkeleton(rows: 2)
				}
			}
			ForEach(TimelineGrouping.rows(store.timeline.reversed())) { row in
				switch row {
				case .day(_, let label):
					Text(label)
						.maskinText(.caption).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.ink4)
						.padding(.top, MaskinSpace.s3)
						.accessibilityAddTraits(.isHeader)
				case .item(let item):
					timelineRow(item)
				case .updates(let id, let items):
					updatesRow(id: id, items: items)
				}
			}
		}
		.accessibilityElement(children: .contain)
	}

	private func timelineRow(_ item: TimelineItem) -> some View {
		TimelineRow(
			item: item, name: store.authorName(for: item), isAgent: store.isAgent(item),
			mentionable: Array(store.directory.actors.values), references: store.references(for: item),
			files: store.attachments(for: item),
			openObject: onOpenObject,
			retry: { Task { await store.retryComment(item.id) } },
			discard: { store.discardComment(item.id) })
	}

	/// A run of system events folded into one tappable line.
	@ViewBuilder private func updatesRow(id: String, items: [TimelineItem]) -> some View {
		let open = expandedRuns.contains(id)
		Button {
			withAnimation(MaskinMotion.standard) {
				if open { expandedRuns.remove(id) } else { expandedRuns.insert(id) }
			}
		} label: {
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: open ? "chevron.down" : "chevron.right")
					.font(.system(size: MaskinFontSize.t11, weight: .semibold))
					.padding(.horizontal, MaskinSpace.s3)
				Text("\(items.count) updates")
				Spacer(minLength: 0)
			}
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.ink4)
			.frame(minHeight: MaskinSpace.s14)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityHint(open ? "Hides the updates" : "Shows the updates")
		if open { ForEach(items) { timelineRow($0) } }
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
	/// Who an `@Name` in a comment can refer to; those names render as mentions.
	var mentionable: [ActorRef] = []
	/// Objects linked from the comment (`/`), shown as chips under it.
	var references: [CommentReference] = []
	/// Files attached to the comment, as cards under it.
	var files: [FileSummary] = []
	var openObject: ((String) -> Void)?
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
					MarkdownContent(CommentMentions.linked(text, actors: mentionable))
						.padding(MaskinSpace.s7)
						.background(
							MaskinSurface.card,
							in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
						)
						.opacity(item.delivery == .sending ? 0.55 : 1)
					if !files.isEmpty {
						ChipFlow {
							ForEach(files) { AttachedFileChip(file: $0) }
						}
					}
					if !references.isEmpty {
						ChipFlow {
							ForEach(references) { ref in
								ReferenceChip(ref: ref, onOpen: openObject.map { open in { open(ref.id) } })
							}
						}
					}
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

/// One property of an object as a roomy capsule: leading glyph or avatar, then the value.
struct PropertyPill<Content: View>: View {
	var fill: Color = MaskinSurface.fill
	@ViewBuilder var content: () -> Content

	var body: some View {
		HStack(spacing: MaskinSpace.s4) { content() }
			.maskinText(.subhead)
			.fontWeight(.medium)
			.lineLimit(1)
			.padding(.horizontal, MaskinSpace.s7)
			.padding(.vertical, MaskinSpace.s5)
			.frame(minHeight: MaskinSpace.touchMin)
			.background(fill, in: Capsule())
			.contentShape(Capsule())
	}
}

/// A small flourish when an object's status changes: a ring swells off the pill and fades. When
/// the new status hands the work to the agents it also throws a few sparks. Still under Reduce Motion.
struct StatusBurst: View {
	let trigger: String
	let color: Color
	let sparks: Bool
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	/// 0 = just fired, 1 = finished (invisible). Rests at 1 so nothing shows on first appearance.
	@State private var progress: CGFloat = 1

	private let sparkCount = 8

	var body: some View {
		ZStack {
			Capsule()
				.strokeBorder(color.opacity(0.5 * (1 - progress)), lineWidth: MaskinSpace.s1)
				.scaleEffect(1 + 0.35 * progress)
			if sparks {
				ForEach(0..<sparkCount, id: \.self) { i in
					let angle = Double(i) / Double(sparkCount) * 2 * .pi
					Circle()
						.fill(color)
						.frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
						.offset(x: cos(angle) * 34 * progress, y: sin(angle) * 22 * progress)
						.opacity(1 - progress)
				}
			}
		}
		.allowsHitTesting(false)
		.accessibilityHidden(true)
		.onChange(of: trigger) { old, _ in
			MaskinHaptics.play(sparks ? .success : .light)
			guard !reduceMotion else { return }
			progress = 0
			Task { @MainActor in
				try? await Task.sleep(for: .milliseconds(30))
				withAnimation(.easeOut(duration: 0.75)) { progress = 1 }
			}
		}
	}
}
