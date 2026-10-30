import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Archived row at the bottom of Team (spec 7 §6): 52pt, archive icon, "Archived", the count
/// and a chevron. Expanded, it lists the archived conversations: tap one to open it, or Unarchive.
/// While searching, `items` are the matches and `forceExpanded` keeps them open.
struct ArchivedRow: View {
	let items: [ConversationSummary]
	let currentActorID: String?
	@Binding var expanded: Bool
	var forceExpanded = false
	let onUnarchive: (ConversationSummary) -> Void
	var onOpen: (ConversationSummary) -> Void = { _ in }

	private var isOpen: Bool { expanded || forceExpanded }

	var body: some View {
		VStack(spacing: 0) {
			Button {
				withAnimation(MaskinMotion.standard) { expanded.toggle() }
			} label: {
				HStack(spacing: MaskinSpace.s7) {
					Image(systemName: "archivebox")
						.maskinSymbol(MaskinFontSize.t15, weight: .medium)
						.foregroundStyle(MaskinColor.ink3)
						.frame(width: MaskinSpace.s14 + MaskinSpace.s1, height: MaskinSpace.s14 + MaskinSpace.s1)
						.background(MaskinSurface.fill, in: Circle())
						.accessibilityHidden(true)
					Text("Archived")
						.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold, relativeTo: .body))
						.foregroundStyle(MaskinColor.ink)
					Spacer(minLength: MaskinSpace.s4)
					Text("\(items.count)")
						.maskinText(.mono)
						.foregroundStyle(MaskinColor.ink5)
					Image(systemName: "chevron.right")
						.maskinSymbol(MaskinFontSize.t13, weight: .semibold)
						.foregroundStyle(MaskinColor.inkPlaceholder)
						.rotationEffect(.degrees(isOpen ? 90 : 0))
				}
				.padding(.horizontal, MaskinSpace.s8 + 1)
				.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s4)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Archived, \(items.count)")
			.accessibilityHint(isOpen ? "Hides the archived conversations" : "Shows the archived conversations")
			if isOpen {
				ForEach(items) { item in
					HStack(spacing: MaskinSpace.s7) {
						Button {
							onOpen(item)
						} label: {
							HStack(spacing: MaskinSpace.s7) {
								ConversationAvatar(
									participants: item.others(excluding: currentActorID),
									size: MaskinSpace.s14 + MaskinSpace.s2)
								VStack(alignment: .leading, spacing: 1) {
									Text(title(item))
										.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold, relativeTo: .body))
										.foregroundStyle(MaskinColor.ink)
										.lineLimit(1)
									Text(subtitle(item))
										.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
										.foregroundStyle(MaskinColor.ink5)
										.lineLimit(1)
								}
								Spacer(minLength: MaskinSpace.s4)
							}
							.contentShape(Rectangle())
						}
						.buttonStyle(.maskinPressed)
						.accessibilityLabel("Open \(title(item))")
						Button("Unarchive") {
							MaskinHaptics.play(.selection)
							onUnarchive(item)
						}
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink2)
						.padding(.horizontal, MaskinSpace.s8)
						.frame(minHeight: MaskinSpace.s14 + MaskinSpace.s2)
						.background(MaskinSurface.fill, in: Capsule())
						.buttonStyle(.maskinPressed)
						.frame(minHeight: MaskinSpace.touchMin)
						.accessibilityLabel("Unarchive \(title(item))")
					}
					.padding(.horizontal, MaskinSpace.s8 + 1)
					.padding(.vertical, MaskinSpace.s4)
					.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s7)
					.overlay(alignment: .top) { Divider().overlay(MaskinSurface.separator) }
				}
			}
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadiusLarge.tile, style: .continuous))
	}

	private func title(_ item: ConversationSummary) -> String {
		TeamLayout.title(of: item, me: currentActorID)
	}

	private func subtitle(_ item: ConversationSummary) -> String {
		if item.isGroupChat(excluding: currentActorID) { return TeamLayout.groupLine(item, me: currentActorID) }
		let title = ChatPreviewText.plain(item.title)
		return title == self.title(item) ? (item.snippet.map(ChatPreviewText.plain) ?? "") : title
	}
}
