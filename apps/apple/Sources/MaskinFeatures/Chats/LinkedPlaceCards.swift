import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What a card face shows for a kind that is not an object: an agent or a chat. The face is the same
/// as the object card's (tile, eyebrow, badge, title, summary, facts, footer, fold); only the words
/// differ.
struct LinkedPlaceFace {
	struct Badge {
		var text: String
		var colors: MaskinColorPair
		/// A pulsing dot before the words ("Working now").
		var pulses = false
	}

	struct Fact {
		var label: String
		var text: String?
		var date: Date?
	}

	var target: LinkedTarget
	var symbol: String
	/// "Agent", "Chat": the kind in words.
	var kindLabel: String
	var badge: Badge?
	var title: String
	var summary: String?
	var facts: [Fact] = []
	var personID: String?
	var personName: String?
	var personIsAgent = false
	var updatedAt: Date?

	/// "{Kind}, {state}: {title}", or "{Kind}: {title}" when there is no state.
	var accessibilityName: String {
		badge.map { "\(kindLabel), \($0.text): \(title)" } ?? "\(kindLabel): \(title)"
	}
}

extension LinkedPlaceFace {
	init(agent: LinkedAgent) {
		var facts: [Fact] = []
		if let lastActive = agent.lastActive { facts.append(Fact(label: "Last active", date: lastActive)) }
		facts.append(Fact(label: "Skills", text: String(agent.skillCount)))
		let badge: Badge? = agent.isWorking.map {
			$0 ? Badge(text: "Working now", colors: MaskinStatus.patina, pulses: true)
				: Badge(text: "Idle", colors: MaskinStatus.fallback)
		}
		self.init(
			target: agent.target, symbol: "cpu", kindLabel: "Agent", badge: badge, title: agent.displayName,
			summary: agent.summary, facts: facts, personID: agent.target.uuid, personName: agent.displayName,
			personIsAgent: true)
	}

	init(chat: LinkedChat) {
		let badge = chat.badge.map { Badge(text: $0, colors: MaskinStatus.fallback) }
		var facts: [Fact] = []
		if let people = chat.peopleLine { facts.append(Fact(label: "People", text: people)) }
		self.init(
			target: chat.target, symbol: "message", kindLabel: "Chat", badge: badge, title: chat.displayTitle,
			summary: chat.summary, facts: facts, personID: chat.lastAuthorID, personName: chat.lastAuthorName,
			personIsAgent: chat.lastAuthorIsAgent, updatedAt: chat.updatedAt)
	}
}

/// The card for a linked agent.
struct LinkedAgentCard: View {
	let agent: LinkedAgent

	var body: some View { LinkedPlaceCard(face: LinkedPlaceFace(agent: agent)) }
}

/// The card for a linked chat.
struct LinkedChatCard: View {
	let chat: LinkedChat

	var body: some View { LinkedPlaceCard(face: LinkedPlaceFace(chat: chat)) }
}

/// One card face for the kinds that are not objects. The body opens the thing; the chevron folds the
/// card to one row. Every card starts open and the fold lives in the view only.
struct LinkedPlaceCard: View {
	let face: LinkedPlaceFace
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.dynamicTypeSize) private var typeSize
	@State private var folded = false
	private let open = LinkedOpener()

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
			Button { open(face.target) } label: { content }
				.buttonStyle(.maskinPressed(.shrink))
				.accessibilityElement(children: .ignore)
				.accessibilityLabel(face.accessibilityName)
				.accessibilityHint("Opens in Maskin")
				.accessibilityAddTraits(.isLink)
			foldButton
		}
	}

	private var content: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s5) {
				tile
				Text(face.kindLabel.uppercased())
					.maskinText(.microLabel)
					.tracking(ChatType.mono11Tracking)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(1)
				Spacer(minLength: 0)
				badge
				// Room for the fold button, which sits above this corner.
				Color.clear.frame(width: MaskinSpace.touchMin - MaskinSpace.s7, height: MaskinSpace.touchMin)
			}
			.frame(minHeight: MaskinSpace.touchMin)
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				Text(face.title)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2).multilineTextAlignment(.leading)
				if let summary = face.summary {
					Text(summary)
						.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
						.foregroundStyle(MaskinColor.ink3)
						.lineLimit(2).multilineTextAlignment(.leading)
				}
			}
			ForEach(Array(face.facts.enumerated()), id: \.offset) { _, fact in self.fact(fact) }
			Rectangle().fill(MaskinSurface.line).frame(height: 1)
			footer
		}
		.padding(.leading, MaskinSpace.s7)
		.padding(.trailing, MaskinSpace.s7)
		.padding(.bottom, MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
	}

	private var tile: some View {
		Image(systemName: face.symbol)
			.maskinSymbol(MaskinFontSize.t14, weight: .semibold)
			.foregroundStyle(MaskinColor.ink)
			.frame(width: MaskinSpace.s13, height: MaskinSpace.s13)
			.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous))
			.accessibilityHidden(true)
	}

	/// The state in words and a tone, never the tone alone.
	@ViewBuilder
	private var badge: some View {
		if let badge = face.badge {
			HStack(spacing: MaskinSpace.s2) {
				if badge.pulses { LinkedPulsingDot(color: badge.colors.fg) }
				Text(badge.text)
					.maskinText(.caption).fontWeight(.semibold)
					.foregroundStyle(badge.colors.fg)
					.lineLimit(1)
			}
			.padding(.horizontal, MaskinSpace.s4)
			.padding(.vertical, MaskinSpace.s1)
			.background(badge.colors.bg, in: Capsule())
		}
	}

	@ViewBuilder
	private func fact(_ fact: LinkedPlaceFace.Fact) -> some View {
		let labelText = Text(fact.label).maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		let value = factValue(fact)
		if stacked {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				labelText
				value
			}
		} else {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s0) {
				labelText.frame(width: Self.factLabelWidth, alignment: .leading)
				value
				Spacer(minLength: 0)
			}
		}
	}

	@ViewBuilder
	private func factValue(_ fact: LinkedPlaceFace.Fact) -> some View {
		Group {
			if let date = fact.date {
				RelativeTime(date, style: .compact)
			} else {
				Text(fact.text ?? "")
			}
		}
		.maskinText(.caption).foregroundStyle(MaskinColor.ink2).lineLimit(1)
	}

	/// The fixed column the facts' labels sit in.
	private static let factLabelWidth: CGFloat = 90

	@ViewBuilder
	private var footer: some View {
		if stacked {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				person
				updated
			}
		} else {
			HStack(spacing: MaskinSpace.s4) {
				person
				Spacer(minLength: 0)
				updated
			}
		}
	}

	@ViewBuilder
	private var person: some View {
		if let name = face.personName, !name.isEmpty {
			HStack(spacing: MaskinSpace.s3) {
				ObjectDriverAvatar(name: name, isAgent: face.personIsAgent, seed: face.personID)
				Text(name).maskinText(.caption).foregroundStyle(MaskinColor.ink3).lineLimit(1)
			}
		}
	}

	@ViewBuilder
	private var updated: some View {
		if let date = face.updatedAt {
			HStack(spacing: MaskinSpace.s1) {
				Text("Updated")
				RelativeTime(date, style: .compact)
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
				Text(face.title)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
					.frame(maxWidth: .infinity, alignment: .leading)
				badge
				LinkedChevron(expanded: false)
					.frame(width: MaskinSpace.s12, height: MaskinSpace.s12)
			}
			.padding(.horizontal, MaskinSpace.s7)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Unfold card: \(face.title)")
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

/// The dot before "Working now": pulses at the design's 1.2s, still under Reduce Motion.
private struct LinkedPulsingDot: View {
	let color: Color
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var dimmed = false

	var body: some View {
		Circle()
			.fill(color)
			.frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
			.opacity(dimmed ? 0.35 : 1)
			.onAppear {
				guard !reduceMotion else { return }
				withAnimation(.easeInOut(duration: MaskinDuration.pulse).repeatForever(autoreverses: true)) {
					dimmed = true
				}
			}
			.accessibilityHidden(true)
	}
}
