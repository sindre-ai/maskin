import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One hit of the Chats list search: the chat's people as the avatar, the title with the typed
/// words highlighted, and the line that matched. A chat the default list leaves out carries a
/// quiet Archived chip and a dimmed avatar.
struct ChatSearchRow: View {
	let hit: ChatSearchHit
	let query: String
	/// The people in the chat when the list has loaded it; a hit it never loaded gets its title's initials.
	let participants: [ChatParticipant]
	let isArchived: Bool

	private var avatarParticipants: [ChatParticipant] {
		participants.isEmpty ? [ChatParticipant(id: hit.id, name: hit.title, kind: .human)] : participants
	}

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			ConversationAvatar(participants: avatarParticipants, size: MaskinSpace.s14 + MaskinSpace.s4)
				.opacity(isArchived ? 0.5 : 1)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(spacing: MaskinSpace.s3) {
					HighlightedText(text: hit.title, query: query)
						.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold, relativeTo: .body))
						.foregroundStyle(isArchived ? MaskinColor.ink4 : MaskinColor.ink)
						.lineLimit(1)
					if isArchived {
						Text("Archived")
							.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .medium, relativeTo: .caption))
							.foregroundStyle(MaskinColor.ink4)
							.padding(.horizontal, MaskinSpace.s3)
							.padding(.vertical, MaskinSpace.s1)
							.background(MaskinSurface.fill, in: Capsule())
					}
					Spacer(minLength: MaskinSpace.s2)
					if let updatedAt = hit.updatedAt {
						RelativeTime(updatedAt, style: .compact)
							.maskinText(.caption)
							.foregroundStyle(MaskinColor.ink5)
					}
				}
				if let line = ChatSearchRules.line(for: hit, query: query) {
					HighlightedText(text: SearchHighlight.snippet(of: line, around: query), query: query)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(2)
				}
			}
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(isArchived ? "\(hit.title), archived" : hit.title)
	}
}

/// Above an archived chat that was opened from search: "Archived. Unarchive". Opening a chat
/// never unarchives it; the button does.
struct ArchivedChatBar: View {
	let onUnarchive: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			Image(systemName: "archivebox")
				.maskinSymbol(MaskinFontSize.t13, weight: .medium)
				.foregroundStyle(MaskinColor.ink4)
				.accessibilityHidden(true)
			Text("Archived.")
				.maskinText(.subhead)
				.foregroundStyle(MaskinColor.ink4)
			Spacer(minLength: MaskinSpace.s4)
			Button("Unarchive") {
				MaskinHaptics.play(.selection)
				onUnarchive()
			}
			.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
			.foregroundStyle(MaskinColor.ink2)
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Unarchive this chat")
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.vertical, MaskinSpace.s4)
		.frame(maxWidth: .infinity)
		.background(MaskinSurface.fill)
		.accessibilityElement(children: .contain)
	}
}
