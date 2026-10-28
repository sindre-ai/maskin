import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A loop a message links to, as a card: its rung, what it is for, how many agents work it and how
/// busy it is. The body opens the flow; the chevron folds the card to one row.
struct LinkedLoopCard: View {
	let loop: LinkedLoop
	@Environment(\.linkedItems) private var store
	private let open = LinkedOpener()

	var body: some View {
		LinkedKindCard(
			symbol: LinkedKindSymbol.loop, eyebrow: "Loop", badge: loop.badge,
			badgeColors: MaskinStatus.colors(for: loop.pill.isLive ? "active" : "paused"), title: loop.displayName,
			summary: loop.summary, facts: facts, person: person, updatedAt: loop.updatedAt,
			accessibilityName: "Loop, \(loop.badge): \(loop.displayName)", open: { open(loop.target) })
	}

	/// Agents and Activity, left out when the loop is not in the loaded list.
	private var facts: [LinkedKindCard.Fact] {
		var facts: [LinkedKindCard.Fact] = []
		if let agents = loop.agentsFact { facts.append(.init(label: "Agents", value: agents)) }
		if let activity = loop.activity { facts.append(.init(label: "Activity", value: activity)) }
		return facts
	}

	/// The first agent. Nothing for a loop with no agents or one that is not in the list.
	private var person: LinkedKindCard.Person? {
		guard let id = loop.firstAgentID else { return nil }
		return LinkedKindCard.Person(actor: store?.owner(for: id), id: id, actorsKnown: store?.actorsByID.isEmpty == false)
	}
}

/// A trigger a message links to, as a card: whether it is on, when it fires in words and which agent
/// it wakes. Never its instruction text or its raw schedule.
struct LinkedTriggerCard: View {
	let trigger: LinkedTrigger
	@Environment(\.linkedItems) private var store
	private let open = LinkedOpener()

	var body: some View {
		LinkedKindCard(
			symbol: trigger.kind.symbol, eyebrow: "Trigger", badge: trigger.badge,
			badgeColors: MaskinStatus.colors(for: trigger.isOn ? "active" : "paused"), title: trigger.displayName,
			summary: trigger.whenItFires, facts: facts, person: person, updatedAt: nil,
			accessibilityName: "Trigger, \(trigger.badge): \(trigger.displayName)", open: { open(trigger.target) })
	}

	/// Wakes: the agent's name, once the workspace's people are read.
	private var facts: [LinkedKindCard.Fact] {
		guard let name = person?.name, !name.isEmpty else { return [] }
		return [.init(label: "Wakes", value: name)]
	}

	private var person: LinkedKindCard.Person? {
		guard !trigger.agentID.isEmpty else { return nil }
		return LinkedKindCard.Person(
			actor: store?.owner(for: trigger.agentID), id: trigger.agentID, actorsKnown: store?.actorsByID.isEmpty == false)
	}
}

enum LinkedKindSymbol {
	/// The Flows tab's symbol.
	static let loop = "arrow.triangle.2.circlepath"
}

/// The card face for a kind that is not an object: tile and eyebrow, a state badge, title, summary,
/// up to three facts, and a footer with one person and a time. The same face as `LinkedObjectCard`,
/// built from plain values so each kind only decides what goes in it.
struct LinkedKindCard: View {
	struct Fact: Identifiable {
		var label: String
		var value: String
		var id: String { label }
	}

	/// The person in the footer. The name is empty while the workspace's people are still loading, so
	/// "Unknown" does not flash.
	struct Person {
		var name: String
		var isAgent: Bool
		var seed: String?

		init(actor: ActorRef?, id: String, actorsKnown: Bool) {
			name = actor?.name ?? (actorsKnown ? "Unknown" : "")
			isAgent = actor?.isAgent == true
			seed = id
		}
	}

	let symbol: String
	let eyebrow: String
	let badge: String
	let badgeColors: MaskinColorPair
	let title: String
	let summary: String?
	let facts: [Fact]
	let person: Person?
	let updatedAt: Date?
	let accessibilityName: String
	let open: () -> Void

	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.dynamicTypeSize) private var typeSize
	@State private var folded = false

	private var stacked: Bool { typeSize.isAccessibilitySize }

	var body: some View {
		LinkedCardChrome {
			if folded { foldedRow } else { openCard }
		}
		.accessibilityElement(children: .contain)
	}

	// MARK: Open

	private var openCard: some View {
		ZStack(alignment: .topTrailing) {
			Button(action: open) { face }
				.buttonStyle(.maskinPressed(.shrink))
				.accessibilityElement(children: .ignore)
				.accessibilityLabel(accessibilityName)
				.accessibilityHint("Opens in Maskin")
				.accessibilityAddTraits(.isLink)
			foldButton
		}
	}

	private var face: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s5) {
				tile
				Text(eyebrow.uppercased())
					.maskinText(.microLabel)
					.tracking(ChatType.mono11Tracking)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(1)
				Spacer(minLength: 0)
				badgeView
				// Room for the fold button, which sits above this corner.
				Color.clear.frame(width: MaskinSpace.touchMin - MaskinSpace.s7, height: MaskinSpace.touchMin)
			}
			.frame(minHeight: MaskinSpace.touchMin)
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				Text(title)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2).multilineTextAlignment(.leading)
				if let summary, !summary.isEmpty {
					Text(summary)
						.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
						.foregroundStyle(MaskinColor.ink3)
						.lineLimit(2).multilineTextAlignment(.leading)
				}
			}
			ForEach(facts) { fact in factRow(label: fact.label, value: fact.value) }
			if person != nil || updatedAt != nil {
				Rectangle().fill(MaskinSurface.line).frame(height: 1)
				footer
			}
		}
		.padding(.leading, MaskinSpace.s7)
		.padding(.trailing, MaskinSpace.s7)
		.padding(.bottom, MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
	}

	private var tile: some View {
		Image(systemName: symbol)
			.maskinSymbol(MaskinFontSize.t14, weight: .semibold)
			.foregroundStyle(MaskinColor.ink)
			.frame(width: MaskinSpace.s13, height: MaskinSpace.s13)
			.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous))
			.accessibilityHidden(true)
	}

	/// The state in words and a tone, never the tone alone.
	private var badgeView: some View {
		Text(badge)
			.maskinText(.caption).fontWeight(.semibold)
			.foregroundStyle(badgeColors.fg)
			.lineLimit(1)
			.padding(.horizontal, MaskinSpace.s4)
			.padding(.vertical, MaskinSpace.s1)
			.background(badgeColors.bg, in: Capsule())
	}

	@ViewBuilder
	private func factRow(label: String, value: String) -> some View {
		let labelText = Text(label).maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		let valueText = Text(value).maskinText(.caption).foregroundStyle(MaskinColor.ink2).lineLimit(1)
		if stacked {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				labelText
				valueText
			}
		} else {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s0) {
				labelText.frame(width: Self.factLabelWidth, alignment: .leading)
				valueText
				Spacer(minLength: 0)
			}
		}
	}

	/// The fixed column the facts' labels sit in.
	private static let factLabelWidth: CGFloat = 90

	@ViewBuilder
	private var footer: some View {
		if stacked {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				personView
				updatedView
			}
		} else {
			HStack(spacing: MaskinSpace.s4) {
				personView
				Spacer(minLength: 0)
				updatedView
			}
		}
	}

	@ViewBuilder
	private var personView: some View {
		if let person {
			HStack(spacing: MaskinSpace.s3) {
				ObjectDriverAvatar(name: person.name, isAgent: person.isAgent, seed: person.seed)
				Text(person.name)
					.maskinText(.caption).foregroundStyle(MaskinColor.ink3).lineLimit(1)
			}
		}
	}

	@ViewBuilder
	private var updatedView: some View {
		if let updatedAt {
			HStack(spacing: MaskinSpace.s1) {
				Text("Updated")
				RelativeTime(updatedAt, style: .compact)
			}
			.maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(1)
		}
	}

	private var foldButton: some View {
		Button(action: toggle) {
			LinkedChevron(expanded: true)
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel("Fold card")
	}

	// MARK: Folded

	private var foldedRow: some View {
		Button(action: toggle) {
			HStack(spacing: MaskinSpace.s5) {
				tile
				Text(title)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
					.frame(maxWidth: .infinity, alignment: .leading)
				badgeView
				LinkedChevron(expanded: false)
					.frame(width: MaskinSpace.s12, height: MaskinSpace.s12)
			}
			.padding(.horizontal, MaskinSpace.s7)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Unfold card: \(title)")
	}

	private func toggle() {
		MaskinHaptics.play(.selection)
		if reduceMotion {
			folded.toggle()
		} else {
			withAnimation(MaskinMotion.standard) { folded.toggle() }
		}
	}
}
