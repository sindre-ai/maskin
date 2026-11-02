import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the nav bar says under the title (spec 7 §4): a live state in `sigInk`, or a quiet label in
/// `fg5`. Direct chats show nothing when quiet; flow chats show `{flow} flow`.
enum ThreadNavStatus: Equatable {
	case live(String)
	case quiet(String)

	var text: String {
		switch self {
		case .live(let s), .quiet(let s): s
		}
	}
}

/// Pure rules for the nav bar, so the variants can be checked without rendering.
enum ThreadNav {
	/// The chat's lead name (its agent, else the other person), or up to three members for a group.
	/// A flow channel is titled with the flow's name.
	static func title(
		participants: [ChatParticipant], currentActorID: String, fallback: String, flow: ChatFlowContext?
	) -> String {
		if let flow { return flow.name }
		let others = participants.filter { $0.id != currentActorID }
		let shown = others.isEmpty ? participants : others
		guard !shown.isEmpty else { return fallback }
		if shown.count == 1 { return shown[0].name }
		let names = shown.prefix(3).map(\.name).joined(separator: ", ")
		return shown.count > 3 ? "\(names) +\(shown.count - 3)" : names
	}

	/// The chat's own title when it is a one-to-one with a custom topic (not the person's name or
	/// the default made from names); nil otherwise, so the nav bar falls back to `title`.
	static func topic(
		chatTitle: String, participants: [ChatParticipant], currentActorID: String, flow: ChatFlowContext?
	) -> String? {
		guard flow == nil else { return nil }
		let others = participants.filter { $0.id != currentActorID }
		guard others.count == 1 else { return nil }
		let names = others.map(\.name)
		let title = chatTitle.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !title.isEmpty, title != ThreadLayout.defaultTitle(for: names), !names.contains(title) else { return nil }
		return ChatPreviewText.plain(title)
	}

	/// `typing…` / `replying…` / `working` while anyone is live; otherwise `{flow} flow` for a flow
	/// chat and nothing for a direct one. A flow channel with several live agents says `n working`
	/// and a single typer `{name} is typing…`.
	static func status(
		presences: [(agent: ChatParticipant, presence: ChatAgentPresence)], flow: ChatFlowContext?
	) -> ThreadNavStatus? {
		if presences.count > 1, flow != nil { return .live("\(presences.count) working") }
		if !presences.isEmpty { return .live("working") }
		if let flow { return .quiet("\(flow.name) flow") }
		return nil
	}

	/// Group chats (3+ members) show the member stack on the right; 1:1 shows no avatar.
	static func showsMemberStack(participants: [ChatParticipant], flow: ChatFlowContext?) -> Bool {
		flow != nil || participants.count >= 3
	}
}

/// The centred nav-bar title: 16pt bold name with the 12pt status line under it.
struct ThreadNavTitle: View {
	let title: String
	var status: ThreadNavStatus?
	var onTap: (() -> Void)?

	var body: some View {
		let content = VStack(spacing: 0) {
			Text(title)
				.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .bold, relativeTo: .headline))
				.foregroundStyle(MaskinColor.ink).lineLimit(1)
			if let status {
				Text(status.text)
					.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
					.foregroundStyle(statusColor(status)).lineLimit(1)
					.transition(.opacity)
			}
		}
		.animation(MaskinMotion.quick, value: status)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
		if let onTap {
			Button(action: onTap) { content.contentShape(Rectangle()) }
				.buttonStyle(.maskinPressed)
				.accessibilityHint("Opens the flow")
		} else {
			content
		}
	}

	private func statusColor(_ status: ThreadNavStatus) -> Color {
		switch status {
		case .live: MaskinColor.sigInk
		case .quiet: MaskinColor.ink5
		}
	}
}

/// Up to `limit` overlapping 32pt avatars. The lead (first) is filled ink in a flow channel.
struct ThreadNavAvatars: View {
	let participants: [ChatParticipant]
	var leadID: String?
	var limit = 4
	var size: CGFloat = MaskinSpace.s14

	var body: some View {
		let shown = Array(participants.prefix(limit))
		HStack(spacing: -size * 0.3) {
			ForEach(shown) { p in
				Group {
					if p.id == leadID {
						Text(ActorIdentity.initials(for: p.name))
							.font(MaskinTypeface.sans(size * 0.38, weight: .semibold, relativeTo: .caption))
							.foregroundStyle(MaskinSurface.onInverse)
							.frame(width: size, height: size)
							.background(MaskinSurface.inverse, in: Circle())
					} else {
						ActorAvatar(name: p.name, kind: p.kind == .agent ? .agent : .human, size: size, seed: p.id)
					}
				}
				.overlay(Circle().strokeBorder(MaskinSurface.card, lineWidth: MaskinSpace.s1))
			}
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(Self.label(participants: participants, leadID: leadID))
	}

	static func label(participants: [ChatParticipant], leadID: String?) -> String {
		let names = participants.map(\.name)
		if let leadID, let lead = participants.first(where: { $0.id == leadID }) {
			let rest = participants.filter { $0.id != leadID }.map(\.name)
			return rest.isEmpty ? "Led by \(lead.name)" : "Led by \(lead.name), with \(rest.joined(separator: ", "))"
		}
		return names.isEmpty ? "People" : "People: \(names.joined(separator: ", "))"
	}
}
