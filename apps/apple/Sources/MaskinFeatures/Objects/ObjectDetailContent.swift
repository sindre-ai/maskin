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
	/// The Latest row jumps to the Activity page.
	var onShowActivity: () -> Void = {}
	/// Long-press on an activity entry sets the composer's reply target.
	var onReply: ((TimelineItem) -> Void)?
	@ViewBuilder var decision: () -> Decision
	@State private var showDetails = false
	@State private var expandedRuns: Set<String> = []

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
					OutcomesSection(outputs: store.outcomes, sourceName: object.displayTitle)
					latestRow
					details(object)
					if !store.links.isEmpty { relationships }
					timeline
				case .header: header(object)
				case .overview:
					header(object)
					decision()
					description(object)
					OutcomesSection(outputs: store.outcomes, sourceName: object.displayTitle)
					latestRow
					details(object)
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

	/// Type glyph and name, the title in full, the Archived banner, the chips (status and driver,
	/// each opening a picker) and when it was last updated (handoff 8).
	private func header(_ object: WorkObject) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			HStack(spacing: MaskinSpace.s3) {
				Image(systemName: ObjectTypeOrder.symbol(for: object.type))
					.maskinSymbol(MaskinFontSize.t14)
					.accessibilityHidden(true)
				Text(store.directory.typeName(object.type))
					.maskinText(.subhead).fontWeight(.semibold)
			}
			.foregroundStyle(MaskinColor.ink4)
			.accessibilityElement(children: .combine)
			.accessibilityLabel("Type \(store.directory.typeName(object.type))")
			Text(object.displayTitle)
				.maskinText(.sheetTitle)
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, alignment: .leading)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityAddTraits(.isHeader)
			if store.isArchived { archivedBanner }
			chips(object)
			if object.updatedAt != nil {
				HStack(spacing: MaskinSpace.s2) {
					Text("Updated")
					RelativeTime(object.updatedAt, style: .compact)
					Text("ago")
				}
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink5)
				.accessibilityElement(children: .combine)
			}
			if let activity = object.activeActivity, !activity.isEmpty {
				Label(activity, systemImage: "sparkles")
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.sigInk)
					.padding(.horizontal, MaskinSpace.s7)
					.padding(.vertical, MaskinSpace.s5)
					.background(MaskinColor.sigTint, in: Capsule())
			}
		}
	}

	private var archivedBanner: some View {
		HStack {
			Text("Archived \u{00B7} still searchable")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
			Spacer(minLength: MaskinSpace.s4)
			Button("Unarchive") {
				MaskinHaptics.play(.selection)
				Task { await store.unarchive() }
			}
			.maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
			.frame(minHeight: MaskinSpace.touchMin)
		}
		.padding(.horizontal, MaskinSpace.s7)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
	}

	/// One row of chips: Status and Driver open a native menu. Priority and due date are not
	/// offered: the object payload carries neither.
	private func chips(_ object: WorkObject) -> some View {
		ChipFlow {
			statusChip(object)
			driverChip(object)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func statusChip(_ object: WorkObject) -> some View {
		Menu {
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
			PropertyPill {
				StatusCategoryGlyph(category: StatusCategory.of(object.status), size: MaskinSpace.s8)
				Text(MaskinStatus.label(for: object.status)).foregroundStyle(MaskinColor.ink)
			}
			.background {
				StatusBurst(
					trigger: object.status, color: MaskinStatus.colors(for: object.status).fg,
					sparks: Self.handsOffStatuses.contains(object.status))
			}
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel("Status \(MaskinStatus.label(for: object.status)). Change status")
	}

	private func driverChip(_ object: WorkObject) -> some View {
		Menu {
			ForEach(store.assignees) { actor in
				Button {
					MaskinHaptics.play(.selection)
					Task { await store.edit(ObjectPatch(driver: actor.id)) }
				} label: {
					if actor.id == object.driverId {
						Label(actor.name, systemImage: "checkmark")
					} else {
						Text(actor.name)
					}
				}
			}
		} label: {
			PropertyPill {
				if let owner = store.ownerName {
					let isAgent = store.directory.actor(for: object.driverId)?.isAgent == true
					ActorAvatar(
						name: owner, kind: isAgent ? .agent : .human, size: MaskinSpace.s10,
						seed: object.driverId, working: object.hasActiveSession)
					Text(owner).foregroundStyle(MaskinColor.ink)
				} else {
					Image(systemName: "person.badge.plus").foregroundStyle(MaskinColor.ink4)
					Text("Driver").foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		.buttonStyle(.maskinPressed)
		.disabled(store.assignees.isEmpty)
		.accessibilityLabel("Driver \(store.ownerName ?? "none"). Change driver")
	}

	/// The newest event; taps through to Activity.
	@ViewBuilder private var latestRow: some View {
		if let item = store.latest {
			Button(action: onShowActivity) {
				HStack(spacing: MaskinSpace.s5) {
					Text("Latest").maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink4)
					(Text(store.authorName(for: item)).fontWeight(.semibold) + Text(" \(latestText(item))"))
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
						.lineLimit(1)
					Spacer(minLength: MaskinSpace.s3)
					RelativeTime(item.date, style: .compact)
						.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
					Image(systemName: "chevron.right")
						.maskinSymbol(MaskinFontSize.t11, weight: .semibold)
						.foregroundStyle(MaskinColor.ink5)
				}
				.padding(.horizontal, MaskinSpace.s8)
				.frame(minHeight: MaskinSpace.touchMin)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityHint("Opens Activity")
		}
	}

	private func latestText(_ item: TimelineItem) -> String {
		switch item.kind {
		case .comment(let text): text.replacingOccurrences(of: "\n", with: " ")
		case .activity(let summary): summary
		}
	}

	/// "Oct 6 by Signal Analyst": when it was made and by whom, when known.
	private func createdText(_ object: WorkObject) -> String? {
		guard let date = object.createdAt else { return nil }
		let day = date.formatted(.dateTime.month(.abbreviated).day())
		if let by = store.directory.name(for: object.createdBy) { return "\(day) by \(by)" }
		return day
	}

	private func propertyRow(_ label: String, value: String, trailing: String? = nil) -> some View {
		HStack(spacing: MaskinSpace.s5) {
			Text(label).maskinText(.body).foregroundStyle(MaskinColor.ink)
			Spacer(minLength: MaskinSpace.s7)
			Text(value)
				.maskinText(.body).foregroundStyle(MaskinColor.ink4)
				.lineLimit(1).truncationMode(.tail)
			if let trailing {
				Image(systemName: trailing)
					.maskinSymbol(MaskinFontSize.t11, weight: .semibold)
					.foregroundStyle(MaskinColor.ink5)
			}
		}
		.padding(.horizontal, MaskinSpace.s9)
		.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s4)
		.contentShape(Rectangle())
	}

	// MARK: Sections

	/// The description as markdown (headings, bullets, numbered steps, bold). Above ~520 characters
	/// it collapses to a fixed height with a fade and "Read all \u{00B7} N min"; no line is ever truncated.
	@ViewBuilder private func description(_ object: WorkObject) -> some View {
		if let content = object.content, !content.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				CollapsibleMarkdown(
					text: content, threshold: Self.descriptionThreshold, collapsedHeight: Self.descriptionHeight,
					expandLabel: ActivityLayout.readLabel(content))
				if let created = createdText(object) {
					Text("Created \(created)").maskinText(.subhead).foregroundStyle(MaskinColor.ink5)
				}
			}
		}
	}

	static var descriptionThreshold: Int { 520 }
	static var descriptionHeight: CGFloat { 240 }

	/// Internal keys (leading underscore, bookkeeping like `previous_status`) stay hidden, and an
	/// actor id reads as the person's or agent's name, never the id.
	private func visibleProperties(_ object: WorkObject) -> [(key: String, value: String)] {
		object.metadata
			.filter { !$0.key.hasPrefix("_") && $0.key != "previous_status" && !$0.value.isEmpty }
			.sorted { $0.key < $1.key }
			.map { ($0.key, store.directory.name(for: $0.value) ?? $0.value) }
	}

	/// The workspace's own fields for this object (metadata), folded away: the Overview leads with
	/// the ask, the description and the evidence, not a property sheet.
	@ViewBuilder private func details(_ object: WorkObject) -> some View {
		let all = visibleProperties(object)
		if !all.isEmpty {
			VStack(alignment: .leading, spacing: 0) {
				Button {
					withAnimation(MaskinMotion.standard) { showDetails.toggle() }
				} label: {
					HStack {
						Text("Details").maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink4)
						Text("\(all.count)").maskinText(.caption).foregroundStyle(MaskinColor.ink5)
						Spacer()
						Image(systemName: "chevron.down")
							.maskinSymbol(MaskinFontSize.t11, weight: .semibold)
							.foregroundStyle(MaskinColor.ink5)
							.rotationEffect(.degrees(showDetails ? 0 : -90))
					}
					.frame(minHeight: MaskinSpace.touchMin)
					.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				if showDetails {
					VStack(spacing: 0) {
						ForEach(Array(all.enumerated()), id: \.element.key) { index, row in
							if index > 0 { Divider().overlay(MaskinSurface.separator) }
							propertyRow(row.key.replacingOccurrences(of: "_", with: " ").capitalized, value: row.value)
						}
					}
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
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
		// Pages and PDFs already have their own section above.
		let presented = Set(store.outcomes.map(\.id))
		for link in store.links where !presented.contains(link.otherId) {
			if buckets[link.phrase] == nil { order.append(link.phrase) }
			buckets[link.phrase, default: []].append(link)
		}
		return order.map { ($0, buckets[$0] ?? []) }
	}

	@ViewBuilder private var relationshipList: some View {
		let groups = linkGroups
		if !groups.isEmpty {
			relationshipGroups(groups)
		}
	}

	private func relationshipGroups(_ groups: [(phrase: String, links: [ObjectLink])]) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s8) {
			if part != .related {
				SectionHeader("Related") {
					Text("\(groups.reduce(0) { $0 + $1.links.count })")
						.maskinText(.mono).foregroundStyle(MaskinColor.ink4)
				}
			}
			ForEach(groups, id: \.phrase) { group in
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					HStack(spacing: MaskinSpace.s3) {
						Text(Self.sentenceCase(group.phrase))
							.maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink3)
						Text("\(group.links.count)").maskinText(.caption).foregroundStyle(MaskinColor.ink5)
					}
					.padding(.horizontal, MaskinSpace.s4)
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

	/// "blocked by" -> "Blocked by".
	static func sentenceCase(_ phrase: String) -> String {
		phrase.prefix(1).uppercased() + phrase.dropFirst()
	}

	/// A related object: a 32pt type-glyph tile, its real title (two lines), status and a chevron.
	@ViewBuilder private func linkRow(_ link: ObjectLink) -> some View {
		let title = link.otherTitle.trimmingCharacters(in: .whitespacesAndNewlines)
		let label = HStack(spacing: MaskinSpace.s7) {
			Image(systemName: ObjectTypeOrder.symbol(for: link.otherType))
				.maskinSymbol(MaskinFontSize.t15)
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
				.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
				.accessibilityHidden(true)
			Text(title.isEmpty ? store.directory.typeName(link.otherType) : title)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(2)
				.multilineTextAlignment(.leading)
			Spacer(minLength: MaskinSpace.s4)
			if let status = link.otherStatus { StatusBadge(status, style: .word) }
			if onOpenObject != nil {
				Image(systemName: "chevron.right")
					.maskinSymbol(MaskinFontSize.t13, weight: .semibold)
					.foregroundStyle(MaskinColor.ink5)
			}
		}
		.padding(MaskinSpace.s8)
		.contentShape(Rectangle())
		if let onOpenObject {
			Button { onOpenObject(link.otherId) } label: { label }.buttonStyle(.maskinPressed)
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
			// Replies sit indented under the comment they answer.
			.padding(.leading, item.parentEventId == nil ? 0 : MaskinSpace.s12)
			.contentShape(Rectangle())
			.onLongPressGesture(minimumDuration: 0.4) {
				guard item.eventId != nil, let onReply else { return }
				MaskinHaptics.play(.selection)
				onReply(item)
			}
			.accessibilityAction(named: "Reply") {
				if item.eventId != nil { onReply?(item) }
			}
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
					.maskinSymbol(MaskinFontSize.t11, weight: .semibold)
					.padding(.horizontal, MaskinSpace.s3)
				Text("\(items.count) updates")
				Spacer(minLength: 0)
			}
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.ink4)
			.frame(minHeight: MaskinSpace.s14)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
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
		case .comment(let text) where ActivityLayout.isComment(item):
			HStack(alignment: .top, spacing: MaskinSpace.s6) {
				ActorAvatar(name: name, kind: isAgent ? .agent : .human, size: MaskinSpace.s13)
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					HStack(spacing: MaskinSpace.s4) {
						Text(name).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
						if isAgent { MonoLabel("Agent", color: MaskinColor.ink5) }
						if ActivityLayout.showsTime(item.date) {
							RelativeTime(item.date, style: .compact)
								.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
						}
					}
					CollapsibleMarkdown(
						text: CommentMentions.linked(text, actors: mentionable),
						threshold: Self.bubbleThreshold, collapsedHeight: Self.bubbleHeight,
						expandLabel: "Show more"
					)
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
		case .comment(let text):
			quietLine(text.replacingOccurrences(of: "\n", with: " "))
		case .activity(let summary):
			quietLine(summary)
		}
	}

	/// ~6 lines of bubble text at body size.
	static var bubbleThreshold: Int { 300 }
	static var bubbleHeight: CGFloat { 150 }

	/// A short system event or comment: a dot, who and what, and the time (today only).
	private func quietLine(_ text: String) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			Circle().fill(MaskinColor.ink5).frame(width: MaskinSpace.s2, height: MaskinSpace.s2)
				.padding(.horizontal, MaskinSpace.s5)
			(Text(name).fontWeight(.semibold).foregroundStyle(MaskinColor.ink3)
				+ Text(" \(text)").foregroundStyle(MaskinColor.ink4))
				.lineLimit(2)
			if ActivityLayout.showsTime(item.date) {
				Spacer(minLength: MaskinSpace.s3)
				RelativeTime(item.date, style: .compact).foregroundStyle(MaskinColor.ink5)
			}
		}
		.maskinText(.caption)
		.frame(minHeight: MaskinSpace.s14, alignment: .leading)
		.accessibilityElement(children: .combine)
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

/// Markdown that folds to a fixed height with a fade once it is long: the description ("Read all
/// \u{00B7} 2 min") and a long comment bubble ("Show more"). Short text renders in full, and no
/// individual line is ever truncated.
struct CollapsibleMarkdown: View {
	let text: String
	let threshold: Int
	let collapsedHeight: CGFloat
	let expandLabel: String
	@State private var expanded = false

	var body: some View {
		let long = text.count > threshold
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			MarkdownContent(text)
				.frame(maxWidth: .infinity, maxHeight: long && !expanded ? collapsedHeight : nil, alignment: .topLeading)
				.clipped()
				.mask(alignment: .top) {
					if long && !expanded {
						LinearGradient(colors: [.black, .black, .clear], startPoint: .top, endPoint: .bottom)
					} else {
						Color.black
					}
				}
			if long {
				Button(expanded ? "Show less" : expandLabel) {
					withAnimation(MaskinMotion.standard) { expanded.toggle() }
				}
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink3)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				.buttonStyle(.maskinPressed)
			}
		}
	}
}
