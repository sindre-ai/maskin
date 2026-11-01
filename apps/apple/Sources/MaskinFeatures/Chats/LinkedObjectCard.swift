import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An object a message links to, as a card: what it is, where it stands, what it says and who has
/// it. The body opens the object; the chevron folds the card to one row. Every card starts open and
/// the fold lives in the view only.
struct LinkedObjectCard: View {
	let object: LinkedObject
	@Environment(\.linkedItems) private var store
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.dynamicTypeSize) private var typeSize
	@Environment(\.linkedInBubble) private var inBubble
	@State private var folded: Bool
	/// The card as the preview sheet shows it: no fold button, and the face does not open the object
	/// (the sheet has its own Open).
	private let preview: Bool
	private let open = LinkedOpener()

	init(object: LinkedObject, defaultFolded: Bool = false, preview: Bool = false) {
		self.object = object
		self.preview = preview
		_folded = State(initialValue: defaultFolded)
	}

	private var colors: MaskinColorPair { MaskinStatus.colors(for: object.status) }
	private var statusLabel: String { MaskinStatus.sentenceLabel(for: object.status) }
	private var stacked: Bool { typeSize.isAccessibilitySize }

	var body: some View {
		LinkedCardChrome {
			if folded { foldedRow } else { openCard }
		}
		.accessibilityElement(children: .contain)
	}

	// MARK: Open

	@ViewBuilder
	private var openCard: some View {
		if preview {
			face
				.accessibilityElement(children: .ignore)
				.accessibilityLabel(cardLabel)
		} else {
			ZStack(alignment: .topTrailing) {
				Button { open(object.target) } label: { face }
					.buttonStyle(.maskinPressed(.shrink))
					.accessibilityElement(children: .ignore)
					.accessibilityLabel(cardLabel)
					.accessibilityHint("Opens in Maskin")
					.accessibilityAddTraits(.isLink)
				foldButton
			}
		}
	}

	private var cardLabel: String { "\(object.kindLabel), \(statusLabel): \(object.displayTitle)" }

	private var face: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s5) {
				tile
				Text(object.kindLabel.uppercased())
					.maskinText(.microLabel)
					.tracking(ChatType.mono11Tracking)
					.foregroundStyle(MaskinColor.ink4)
					.lineLimit(1)
				Spacer(minLength: 0)
				badge
				// Room for the fold button, which sits above this corner.
				if !preview {
					Color.clear.frame(width: MaskinSpace.touchMin - MaskinSpace.s7, height: MaskinSpace.touchMin)
				}
			}
			.frame(minHeight: MaskinSpace.touchMin)
			VStack(alignment: .leading, spacing: MaskinSpace.s3) {
				Text(object.displayTitle)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2).multilineTextAlignment(.leading)
				if let summary = object.summary {
					Text(summary)
						.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
						.foregroundStyle(MaskinColor.ink3)
						.lineLimit(inBubble ? 1 : 2).multilineTextAlignment(.leading)
				}
			}
			if let priority = object.priority { fact(label: "Priority", value: priority) }
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
		Image(systemName: MaskinObjectType.glyph(for: object.type))
			.maskinSymbol(MaskinFontSize.t14, weight: .semibold)
			.foregroundStyle(MaskinColor.ink)
			.frame(width: MaskinSpace.s13, height: MaskinSpace.s13)
			.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous))
			.accessibilityHidden(true)
	}

	/// The status in words and a tone, never the tone alone.
	private var badge: some View {
		Text(statusLabel)
			.maskinText(.caption).fontWeight(.semibold)
			.foregroundStyle(colors.fg)
			.lineLimit(1)
			.padding(.horizontal, MaskinSpace.s4)
			.padding(.vertical, MaskinSpace.s1)
			.background(colors.bg, in: Capsule())
	}

	@ViewBuilder
	private func fact(label: String, value: String) -> some View {
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
				owner
				updated
			}
		} else {
			HStack(spacing: MaskinSpace.s4) {
				owner
				Spacer(minLength: 0)
				updated
			}
		}
	}

	private var owner: some View {
		let actor = store?.owner(for: object.ownerID)
		let actorsKnown = store?.actorsByID.isEmpty == false
		return HStack(spacing: MaskinSpace.s3) {
			ObjectDriverAvatar(name: actor?.name, isAgent: actor?.isAgent == true, seed: object.ownerID)
			Text(ownerName(actor, actorsKnown: actorsKnown))
				.maskinText(.caption).foregroundStyle(MaskinColor.ink3).lineLimit(1)
		}
	}

	/// An empty name while the workspace's people are still loading, so "Unknown" does not flash.
	private func ownerName(_ actor: ActorRef?, actorsKnown: Bool) -> String {
		if let actor { return actor.name }
		if object.ownerID == nil { return "Unassigned" }
		return actorsKnown ? "Unknown" : ""
	}

	@ViewBuilder
	private var updated: some View {
		if let date = object.updatedAt {
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
				Text(object.displayTitle)
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
		.accessibilityLabel("Unfold card: \(object.displayTitle)")
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

/// The card for an object that was deleted: dashed, with one line saying so. The lookup cannot tell
/// deleted from private, and nothing is private inside a workspace, so it never says "private".
struct LinkedDeletedCard: View {
	var kind = "object"
	var symbol = "trash"
	/// Replaces "This {kind} was deleted", for a card that says something else (a chat you cannot see).
	var text: String?

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: symbol)
				.maskinSymbol(MaskinFontSize.t14, weight: .semibold)
				.foregroundStyle(MaskinColor.ink4)
				.accessibilityHidden(true)
			Text(text ?? "This \(kind) was deleted")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				.multilineTextAlignment(.leading)
			Spacer(minLength: 0)
		}
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.vertical, MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.strokeBorder(MaskinSurface.line, style: StrokeStyle(lineWidth: 1, dash: [MaskinSpace.s2, MaskinSpace.s2]))
		)
		.accessibilityElement(children: .combine)
	}
}

/// What stands in for a card while its object is looked up: a block the card's size, pulsing.
struct LinkedCardSkeleton: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var dimmed = false

	/// The height of an open card's placeholder.
	private static let height: CGFloat = 104

	var body: some View {
		RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
			.fill(MaskinSurface.fill)
			.frame(height: Self.height)
			.opacity(dimmed ? 0.5 : 1)
			.onAppear {
				guard !reduceMotion else { return }
				withAnimation(.easeInOut(duration: MaskinDuration.pulse).repeatForever(autoreverses: true)) {
					dimmed = true
				}
			}
			.accessibilityElement(children: .ignore)
			.accessibilityLabel("Loading")
	}
}
