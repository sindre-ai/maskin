import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Overview page body, under the pinned page bar: the ask (decision card), the fields card,
/// the description as headed sections, the evidence (pages and PDFs this object produced), a
/// "Latest" row that jumps to Activity, and "Discuss in {flow}" when the object sits in a flow.
struct ObjectOverviewView<Decision: View>: View {
	let store: ObjectDetailStore
	let object: WorkObject
	/// The description starts unfolded (snapshots).
	var descriptionExpanded = false
	var onShowActivity: () -> Void = {}
	/// Opens a linked object; the flow button needs it, and hides without it.
	var onOpenObject: ((String) -> Void)?
	@ViewBuilder var decision: () -> Decision

	var body: some View {
		let content = ObjectDetailLayout.sections(of: object.content)
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			decision()
			ObjectFieldsCard(store: store, object: object)
			if !content.lead.isEmpty {
				DetailSection("Summary") {
					CollapsibleDescription(content: content.lead, initiallyExpanded: descriptionExpanded)
				}
			}
			ForEach(content.sections) { section in
				DetailSection(section.heading) {
					MarkdownContent(section.body, style: .description)
						.fixedSize(horizontal: false, vertical: true)
						.frame(maxWidth: .infinity, alignment: .leading)
				}
			}
			OutcomesSection(outputs: store.outcomes, sourceName: object.displayTitle)
			if let latest = store.latest {
				LatestRow(
					who: store.authorName(for: latest), what: ActivityGrouping.summary(of: latest), date: latest.date,
					action: onShowActivity)
			}
			if let flow = ObjectDetailLayout.flow(in: store.links), let onOpenObject {
				DiscussInFlowButton(flowName: flow.otherTitle) { onOpenObject(flow.otherId) }
			}
		}
	}
}

extension View {
	/// The white card the Overview groups content in: radius 22, a 1px hairline.
	func detailCard() -> some View {
		background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)
					.strokeBorder(MaskinSurface.separator, lineWidth: 1))
	}
}

/// A mono caps label over a card ("SUMMARY", "NEXT"), the Overview's section shape.
struct DetailSection<Content: View>: View {
	let title: String
	@ViewBuilder var content: Content

	init(_ title: String, @ViewBuilder content: () -> Content) {
		self.title = title
		self.content = content()
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			Text(title.uppercased())
				.font(MaskinTypeface.mono(MaskinFontSize.t12, weight: .semibold)).tracking(0.88)
				.foregroundStyle(MaskinColor.ink5)
				.padding(.horizontal, MaskinSpace.s2)
				.accessibilityAddTraits(.isHeader)
			content
				.padding(.horizontal, MaskinSpace.s8)
				.padding(.vertical, MaskinSpace.s7)
				.frame(maxWidth: .infinity, alignment: .leading)
				.detailCard()
		}
	}
}

/// "Discuss in {flow}": the primary action at the foot of the Overview, a dark teal capsule.
struct DiscussInFlowButton: View {
	let flowName: String
	let action: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.selection)
			action()
		} label: {
			Label("Discuss in \(flowName)", systemImage: "bubble.left")
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold, relativeTo: .body))
				.foregroundStyle(MaskinSurface.onInverse)
				.lineLimit(1)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s3)
				.background(MaskinSurface.inverse, in: Capsule())
				.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed)
	}
}

/// "Latest · **Forge** moved status to active · 2h ›" — the newest event, as a door to Activity.
struct LatestRow: View {
	let who: String
	let what: String
	let date: Date?
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s5) {
				Text("Latest")
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink5)
				(Text(who).fontWeight(.semibold) + Text(" ") + Text(what))
					.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink2)
					.lineLimit(1)
					.truncationMode(.tail)
					.frame(maxWidth: .infinity, alignment: .leading)
				RelativeTime(date, style: .compact)
					.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink5)
				Image(systemName: "chevron.right")
					.maskinSymbol(MaskinFontSize.t12, weight: .bold)
					.foregroundStyle(MaskinColor.ink5)
			}
			.padding(.leading, MaskinSpace.s9)
			.padding(.trailing, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s4)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel("Latest: \(who) \(what). Opens activity")
	}
}

/// The object's fields as label and value rows with 1px dividers: status, driver, priority, due and
/// updated first (each opens its picker), then the workspace fields that have no row of their own.
/// Internal keys (leading underscore, bookkeeping) stay hidden, and an actor id reads as the
/// person's or agent's name, never the id.
struct ObjectFieldsCard: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let store: ObjectDetailStore
	let object: WorkObject
	@State private var showAll = false
	@State private var pickingDue = false

	private static var preview: Int { 4 }

	private var extras: [(key: String, value: String)] {
		let chipped = Set([ObjectDetailStore.priorityKey] + ObjectDetailStore.dueKeys)
		return object.metadata
			.filter { !$0.key.hasPrefix("_") && $0.key != "previous_status" && !$0.value.isEmpty && !chipped.contains($0.key) }
			.sorted { $0.key < $1.key }
			.map { ($0.key, store.directory.name(for: $0.value) ?? $0.value) }
	}

	var body: some View {
		let all = extras
		VStack(spacing: 0) {
			row("Status") {
				Menu { ObjectStatusMenuItems(store: store, object: object) } label: {
					let colors = MaskinStatus.colors(for: object.status)
					picker(MaskinStatus.sentenceLabel(for: object.status), dot: colors.fg)
				}
				.accessibilityLabel("Status \(MaskinStatus.label(for: object.status)). Change status")
			}
			divider
			row("Driver") {
				Menu { ObjectDriverMenuItems(store: store, object: object) } label: {
					picker(store.ownerName ?? "No driver", muted: store.ownerName == nil)
				}
				.accessibilityLabel("Driver \(store.ownerName ?? "none"). Change driver")
			}
			divider
			row("Priority") {
				Menu { ObjectPriorityMenuItems(store: store, priority: store.priority) } label: {
					picker(
						store.priority.map { $0.replacingOccurrences(of: "_", with: " ").capitalized } ?? "Not set",
						muted: store.priority == nil)
				}
				.accessibilityLabel("Priority \(store.priority ?? "none"). Change priority")
			}
			divider
			row("Due") {
				Button { pickingDue = true } label: {
					picker(
						store.dueDate.map { $0.formatted(.dateTime.day().month(.abbreviated).year()) } ?? "Not set",
						muted: store.dueDate == nil)
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("Due \(store.dueDate?.formatted(date: .long, time: .omitted) ?? "none"). Change due date")
			}
			if let updated = object.updatedAt {
				divider
				row("Updated") { RelativeTime(updated).foregroundStyle(MaskinColor.ink) }
			}
			ForEach(showAll ? all : Array(all.prefix(Self.preview)), id: \.key) { field in
				divider
				row(field.key.replacingOccurrences(of: "_", with: " ").capitalized) { Text(field.value) }
			}
			if all.count > Self.preview {
				divider
				Button(showAll ? "Show fewer" : "Show all \(all.count)") {
					withAnimation(reduceMotion ? nil : MaskinMotion.standard) { showAll.toggle() }
				}
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
			}
		}
		.padding(.horizontal, MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.detailCard()
		.sheet(isPresented: $pickingDue) {
			DuePickerSheet(date: store.dueDate) { date in Task { await store.setDueDate(date) } }
		}
	}

	private var divider: some View {
		Rectangle().fill(MaskinSurface.separator).frame(height: 1)
	}

	private func row<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s6) {
			Text(label)
				.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
				.foregroundStyle(MaskinColor.ink4)
				.frame(width: MaskinSpace.s12 * 4, alignment: .leading)
			value()
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.frame(minHeight: MaskinSpace.touchMin)
		.padding(.vertical, MaskinSpace.s1)
	}

	private func picker(_ text: String, dot: Color? = nil, muted: Bool = false) -> some View {
		HStack(spacing: MaskinSpace.s3) {
			if let dot { Circle().fill(dot).frame(width: MaskinSpace.s4, height: MaskinSpace.s4) }
			Text(text).foregroundStyle(muted ? MaskinColor.ink4 : MaskinColor.ink)
			Image(systemName: "chevron.up.chevron.down")
				.maskinSymbol(MaskinFontSize.t12, weight: .semibold)
				.foregroundStyle(MaskinColor.ink5)
		}
		.frame(minHeight: MaskinSpace.touchMin)
		.contentShape(Rectangle())
	}
}
