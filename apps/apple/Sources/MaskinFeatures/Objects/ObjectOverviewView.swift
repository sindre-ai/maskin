import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Overview page body, under the pinned header: the description (always, with a quiet
/// placeholder when empty), the evidence (pages and PDFs this object produced), the properties
/// (always: status, owner, priority, due, dates, then any workspace fields), the ask (decision
/// card, when one waits on the reader) below them, and a "Latest" row that jumps to
/// Activity. Stateless apart from the store it reads.
struct ObjectOverviewView<Decision: View>: View {
	let store: ObjectDetailStore
	let object: WorkObject
	/// The description starts unfolded (snapshots).
	var descriptionExpanded = false
	var onShowActivity: () -> Void = {}
	@ViewBuilder var decision: () -> Decision

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s8) {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				SectionHeader("Description")
				Group {
					if let content = object.content, !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
						CollapsibleDescription(content: content, initiallyExpanded: descriptionExpanded)
					} else {
						Text("No description yet.")
							.maskinText(.subhead)
							.foregroundStyle(MaskinColor.ink4)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s9)
				.background(
					MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
			}
			OutcomesSection(outputs: store.outcomes, sourceName: object.displayTitle)
			ObjectPropertiesCard(store: store, object: object)
			decision()
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

/// The object's properties as a quiet key/value card: status, owner, priority, due and the
/// dates, then the workspace fields that have no chip of their own (effort, area…). Internal
/// keys (leading underscore, bookkeeping) stay hidden, and an actor id reads as the person's or
/// agent's name, never the id.
struct ObjectPropertiesCard: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	let store: ObjectDetailStore
	let object: WorkObject
	@State private var showAll = false

	private static var preview: Int { 6 }

	/// "due_date" -> "Due date", "estimatedEffort" -> "Estimated effort".
	static func label(for key: String) -> String {
		var words = ""
		for ch in key {
			if ch == "_" || ch == "-" {
				words.append(" ")
			} else if ch.isUppercase, !words.isEmpty, words.last != " " {
				words.append(" ")
				words.append(contentsOf: ch.lowercased())
			} else {
				words.append(ch)
			}
		}
		return words.prefix(1).uppercased() + words.dropFirst()
	}

	/// "Tomorrow · 5 Nov", "3 days ago · 12 Oct".
	static func dueText(_ date: Date, now: Date = Date()) -> String {
		let relative = RelativeDateTimeFormatter()
		relative.dateTimeStyle = .named
		let phrase = relative.localizedString(for: date, relativeTo: now)
		return "\(phrase.prefix(1).uppercased() + phrase.dropFirst()) · \(date.formatted(.dateTime.day().month(.abbreviated)))"
	}

	private var rows: [(key: String, label: String, value: String)] {
		let chipped = Set([ObjectDetailStore.priorityKey] + ObjectDetailStore.dueKeys)
		var core: [(key: String, value: String?)] = [
			("Status", MaskinStatus.sentenceLabel(for: object.status)),
			("Owner", store.ownerName),
			("Priority", store.priority?.capitalized),
			("Due", store.dueDate.map { Self.dueText($0) }),
			("Created", object.createdAt?.formatted(date: .abbreviated, time: .omitted)),
			("Last updated", object.updatedAt?.formatted(date: .abbreviated, time: .omitted)),
		]
		core.removeAll { ($0.value ?? "").isEmpty }
		let extra = object.metadata
			.filter { !$0.key.hasPrefix("_") && $0.key != "previous_status" && !$0.value.isEmpty && !chipped.contains($0.key) }
			.sorted { $0.key < $1.key }
			.map { (key: $0.key, label: Self.label(for: $0.key), value: store.directory.name(for: $0.value) ?? $0.value) }
		return core.map { (key: $0.key, label: $0.key, value: $0.value ?? "") } + extra
	}

	var body: some View {
		let all = rows
		if !all.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				SectionHeader("Properties")
				VStack(spacing: MaskinSpace.s6) {
					ForEach(showAll ? all : Array(all.prefix(Self.preview)), id: \.key) { row in
						HStack(alignment: .firstTextBaseline) {
							Text(row.label)
								.foregroundStyle(MaskinColor.ink4)
							Spacer(minLength: MaskinSpace.s7)
							Text(row.value).foregroundStyle(MaskinColor.ink).multilineTextAlignment(.trailing)
						}
						.maskinText(.subhead)
					}
					if all.count > Self.preview {
						Button(showAll ? "Show fewer" : "Show all \(all.count)") {
							withAnimation(reduceMotion ? nil : MaskinMotion.standard) { showAll.toggle() }
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
