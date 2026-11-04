import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One item in the list, to the handoff's flat row (13-items): the star at the left, the title,
/// "Type · Owner" under it, the ask in blue when one waits on the reader, and the status at the
/// right. Hairlines between rows come from the list. The board keeps `ObjectRow`'s card.
struct ObjectFlatRow: View {
	let object: WorkObject
	let typeName: String
	/// The list mixes types, so the subtitle says which one this is.
	var showsType = true
	var ask: ObjectAsk?
	var ownerName: String?
	var showsStatus = true
	var showsDriver = true
	var showsUpdated = true
	/// Taps on the star. Nil draws a plain star.
	var onToggleStar: (() -> Void)?

	private var unseen: Bool { object.unreadCount > 0 }
	private var needsYou: Bool { ask != nil || ObjectsUrgency.needsYou(object) }

	/// "Task · Architect", or just the part that is shown.
	var subtitle: String {
		var parts: [String] = []
		if showsType { parts.append(typeName) }
		if showsDriver, let ownerName, !ownerName.isEmpty { parts.append(ownerName) }
		return parts.joined(separator: " · ")
	}

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s5) {
			star
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(object.displayTitle)
					.maskinText(.headline)
					.fontWeight(unseen ? .bold : .regular)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
					.truncationMode(.tail)
				if !subtitle.isEmpty {
					Text(subtitle).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(1)
				}
				if let ask { askLine(ask) }
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			trailing
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
		.accessibilityElement(children: .contain)
		.accessibilityLabel(accessibilityLabel)
	}

	@ViewBuilder private var star: some View {
		let symbol = Image(systemName: object.isStarred ? "star.fill" : "star")
			.maskinSymbol(MaskinFontSize.t17, weight: .regular)
			.foregroundStyle(object.isStarred ? MaskinColor.sigInk : MaskinColor.ink4)
			.frame(width: MaskinSpace.touchMin - MaskinSpace.s4, height: MaskinSpace.touchMin - MaskinSpace.s4)
		if let onToggleStar {
			Button {
				MaskinHaptics.play(.selection)
				onToggleStar()
			} label: { symbol.contentShape(Rectangle()) }
				.buttonStyle(.borderless)
				.accessibilityLabel(object.isStarred ? "Remove from favourites" : "Add to favourites")
		} else {
			symbol.accessibilityHidden(true)
		}
	}

	private var trailing: some View {
		VStack(alignment: .trailing, spacing: MaskinSpace.s1) {
			HStack(spacing: MaskinSpace.s3) {
				if unseen {
					Circle().fill(MaskinColor.sig)
						.frame(width: MaskinSpace.s3 + 1, height: MaskinSpace.s3 + 1)
						.accessibilityHidden(true)
				}
				if object.hasActiveSession { ObjectWorkingBars() }
				if showsStatus {
					Text(MaskinStatus.sentenceLabel(for: object.status))
						.maskinText(.subhead)
						.foregroundStyle(ObjectsStatusTone.of(object).color)
						.lineLimit(1)
				}
			}
			if showsUpdated {
				RelativeTime(object.updatedAt, style: .compact)
					.maskinText(.caption).monospacedDigit().foregroundStyle(MaskinColor.ink5)
			}
		}
		.fixedSize(horizontal: true, vertical: false)
		.padding(.top, MaskinSpace.s2)
	}

	private func askLine(_ ask: ObjectAsk) -> some View {
		Group {
			if let who = ask.askedBy, !who.isEmpty {
				// The handoff reads "Ask SEO Researcher · proposed from …" with only "Ask" bold.
				Text("Ask").fontWeight(.semibold) + Text(" \(who) · \(ask.text)")
			} else {
				Text("Ask").fontWeight(.semibold) + Text(" \(ask.text)")
			}
		}
		.maskinText(.subhead)
		.foregroundStyle(MaskinColor.sigInk)
		.lineLimit(1)
	}

	private var accessibilityLabel: String {
		var parts = [typeName, object.displayTitle]
		if object.isStarred { parts.append("Favourite") }
		if unseen { parts.append("Changed since you last looked") }
		if let ask { parts.append("Needs you. \(ask.line)") } else if needsYou { parts.append("Needs you") }
		if let ownerName, showsDriver { parts.append("owned by \(ownerName)") }
		if object.hasActiveSession { parts.append("Agent working") }
		parts.append(MaskinStatus.sentenceLabel(for: object.status))
		return parts.joined(separator: ", ")
	}
}
