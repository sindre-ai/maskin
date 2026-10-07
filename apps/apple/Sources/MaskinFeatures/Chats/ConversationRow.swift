import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One conversation in the list: a 40pt avatar (two overlapped for a group chat), the title over
/// "Agent · preview", the time in the Messages style and an unread count. An unread chat reads
/// louder: a bold title, a darker preview and the count badge.
struct ConversationRow: View {
	let conversation: ConversationSummary
	let currentActorID: String?
	/// "Now" for the time label; fixed in snapshot tests.
	var now = Date()

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			ConversationAvatar(participants: others, size: Self.avatarSize)
				.frame(width: Self.clusterWidth, height: Self.avatarSize)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Text(ChatPreviewText.plain(conversation.title))
						.maskinText(.body)
						.fontWeight(conversation.isUnread ? .bold : .semibold)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(2)
					Spacer(minLength: MaskinSpace.s3)
					if conversation.pinned {
						Image(systemName: "pin.fill")
							.font(.caption2)
							.foregroundStyle(MaskinColor.ink5)
							.accessibilityHidden(true)
					}
					if let date = conversation.activityDate {
						Text(ChatListTime.label(for: date, now: now))
							.maskinText(.caption)
							.foregroundStyle(conversation.isUnread ? MaskinColor.sigInk : MaskinColor.ink4)
					}
				}
				HStack(alignment: .top, spacing: MaskinSpace.s4) {
					previewLine
						.maskinText(.subhead)
						.foregroundStyle(conversation.isUnread ? MaskinColor.ink2 : MaskinColor.ink4)
						.lineLimit(2)
					Spacer(minLength: 0)
					if conversation.isUnread { UnreadBadge(count: conversation.unreadCount) }
				}
			}
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	static let avatarSize: CGFloat = MaskinSpace.s14 + MaskinSpace.s4
	/// A group chat's two avatars sit in a 44 x 40 cluster.
	static let clusterWidth: CGFloat = MaskinSpace.s14 + MaskinSpace.s7

	private var others: [ChatParticipant] { conversation.others(excluding: currentActorID) }

	/// Whose words the preview shows: the last sender, else who the chat is with.
	private var previewName: String {
		if let who = conversation.snippetActorName, !who.isEmpty { return who }
		return conversation.counterpartName(excluding: currentActorID)
	}

	private var previewText: String? {
		guard let text = conversation.snippet.map(ChatPreviewText.plain), !text.isEmpty else { return nil }
		return text
	}

	/// "**Relay** · Done, the PR is up"; just the name when the server sent no snippet.
	private var previewLine: Text {
		guard let previewText else { return Text(previewName) }
		return Text("\(Text(previewName).fontWeight(.semibold)) · \(previewText)")
	}

	private var accessibilityLabel: String {
		var parts = [ChatPreviewText.plain(conversation.title), previewName]
		if let previewText { parts.append(previewText) }
		if conversation.isUnread { parts.append("\(conversation.unreadCount) unread") }
		if conversation.pinned { parts.append("pinned") }
		return parts.joined(separator: ", ")
	}
}

struct UnreadBadge: View {
	let count: Int
	var body: some View {
		Text(count > 99 ? "99+" : "\(count)")
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.badgeFg)
			.padding(.horizontal, MaskinSpace.s3)
			.frame(minWidth: MaskinSpace.s10, minHeight: MaskinSpace.s10)
			.background(MaskinGradient.badge, in: Capsule())
			.accessibilityHidden(true)
	}
}

/// One avatar for a one-to-one chat, two overlapped for a group.
struct ConversationAvatar: View {
	let participants: [ChatParticipant]
	var size: CGFloat = MaskinSpace.s14 + MaskinSpace.s4
	/// An agent in this chat is running right now.
	var working = false

	var body: some View {
		if participants.count <= 1, let only = participants.first {
			ActorAvatar(
				name: only.name, kind: only.kind == .agent ? .agent : .human, size: size, seed: only.id,
				working: working)
		} else if participants.count >= 2 {
			let small = size * 0.65
			ZStack {
				avatar(participants[0], small).offset(x: -size * 0.225, y: -size * 0.175)
				avatar(participants[1], small)
					.offset(x: size * 0.225, y: size * 0.175)
			}
			.frame(width: size * 1.1, height: size)
		} else {
			Circle().fill(MaskinSurface.fill).frame(width: size, height: size)
		}
	}

	private func avatar(_ p: ChatParticipant, _ s: CGFloat) -> some View {
		ActorAvatar(
			name: p.name, kind: p.kind == .agent ? .agent : .human, size: s, seed: p.id)
	}
}
