import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Overview page body, under the pinned header: the ask (decision card), the description,
/// the evidence (pages and PDFs this object produced), any remaining properties, and a "Latest"
/// row that jumps to Activity. Stateless apart from the store it reads.
struct ObjectOverviewView<Decision: View>: View {
	let store: ObjectDetailStore
	let object: WorkObject
	/// The description starts unfolded (snapshots).
	var descriptionExpanded = false
	var onShowActivity: () -> Void = {}
	@ViewBuilder var decision: () -> Decision

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s8) {
			decision()
			if let content = object.content, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
				CollapsibleDescription(content: content, initiallyExpanded: descriptionExpanded)
					.padding(.horizontal, MaskinSpace.s9)
					.padding(.vertical, MaskinSpace.s9)
					.background(
						MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			}
			OutcomesSection(outputs: store.outcomes, sourceName: object.displayTitle)
			ObjectPropertiesCard(store: store, object: object)
			if let latest = store.latest {
				LatestRow(
					who: store.authorName(for: latest), what: ActivityGrouping.summary(of: latest), date: latest.date,
					action: onShowActivity)
			}
		}
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

/// Workspace fields that have no chip of their own (effort, area…), as a quiet key/value card.
/// Internal keys (leading underscore, bookkeeping) stay hidden, and an actor id reads as the
/// person's or agent's name, never the id.
struct ObjectPropertiesCard: View {
	let store: ObjectDetailStore
	let object: WorkObject
	@State private var showAll = false

	private static var preview: Int { 4 }

	private var rows: [(key: String, value: String)] {
		let chipped = Set([ObjectDetailStore.priorityKey] + ObjectDetailStore.dueKeys)
		return object.metadata
			.filter { !$0.key.hasPrefix("_") && $0.key != "previous_status" && !$0.value.isEmpty && !chipped.contains($0.key) }
			.sorted { $0.key < $1.key }
			.map { ($0.key, store.directory.name(for: $0.value) ?? $0.value) }
	}

	var body: some View {
		let all = rows
		if !all.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				SectionHeader("Properties")
				VStack(spacing: MaskinSpace.s6) {
					ForEach(showAll ? all : Array(all.prefix(Self.preview)), id: \.key) { row in
						HStack(alignment: .firstTextBaseline) {
							Text(row.key.replacingOccurrences(of: "_", with: " ").capitalized)
								.foregroundStyle(MaskinColor.ink4)
							Spacer(minLength: MaskinSpace.s7)
							Text(row.value).foregroundStyle(MaskinColor.ink).multilineTextAlignment(.trailing)
						}
						.maskinText(.subhead)
					}
					if all.count > Self.preview {
						Button(showAll ? "Show fewer" : "Show all \(all.count)") {
							withAnimation(MaskinMotion.standard) { showAll.toggle() }
						}
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
					}
				}
				.padding(MaskinSpace.s9)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			}
		}
	}
}
