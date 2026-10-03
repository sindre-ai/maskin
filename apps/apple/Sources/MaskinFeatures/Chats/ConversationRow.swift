import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One conversation in the list: the agent's icon, the agent's name over the conversation
/// title, the time and unread state. No message preview.
struct ConversationRow: View {
	let conversation: ConversationSummary
	let currentActorID: String?

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s7) {
			ConversationAvatar(participants: others)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Text(headline)
						.maskinText(.headline)
						.fontWeight(conversation.isUnread ? .bold : .semibold)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					if conversation.pinned {
						Image(systemName: "pin.fill")
							.font(.caption2)
							.foregroundStyle(MaskinColor.ink5)
							.accessibilityHidden(true)
					}
					Spacer(minLength: MaskinSpace.s3)
					RelativeTime(conversation.activityDate, style: .compact)
						.maskinText(.caption)
						.foregroundStyle(conversation.isUnread ? MaskinColor.accent : MaskinColor.ink4)
				}
				HStack(alignment: .center, spacing: MaskinSpace.s4) {
					Text(conversation.title)
						.maskinText(.subhead)
						.foregroundStyle(conversation.isUnread ? MaskinColor.ink2 : MaskinColor.ink4)
						.lineLimit(1)
					Spacer(minLength: 0)
					if conversation.isUnread {
						UnreadBadge(count: conversation.unreadCount)
					}
				}
			}
		}
		.padding(.vertical, MaskinSpace.s2)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	private var others: [ChatParticipant] {
		let rest = conversation.participants.filter { $0.id != currentActorID }
		return rest.isEmpty ? conversation.participants : rest
	}

	/// The agents in the chat; with none, the other people.
	private var headline: String {
		let agents = others.filter { $0.kind == .agent }
		let names = (agents.isEmpty ? others : agents).map(\.name)
		return names.isEmpty ? conversation.title : names.joined(separator: ", ")
	}

	private var accessibilityLabel: String {
		var parts = [headline, conversation.title]
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
			.foregroundStyle(MaskinSurface.onInverse)
			.padding(.horizontal, MaskinSpace.s3)
			.frame(minWidth: MaskinSpace.s9, minHeight: MaskinSpace.s9)
			.background(MaskinColor.accent, in: Capsule())
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
			let small = size * 0.66
			ZStack {
				avatar(participants[0], small).offset(x: -size * 0.17, y: -size * 0.17)
				avatar(participants[1], small)
					.overlay(Circle().strokeBorder(MaskinSurface.card, lineWidth: MaskinSpace.s1))
					.offset(x: size * 0.17, y: size * 0.17)
			}
			.frame(width: size, height: size)
		} else {
			Circle().fill(MaskinSurface.fill).frame(width: size, height: size)
		}
	}

	private func avatar(_ p: ChatParticipant, _ s: CGFloat) -> some View {
		ActorAvatar(
			name: p.name, kind: p.kind == .agent ? .agent : .human, size: s, seed: p.id)
	}
}
