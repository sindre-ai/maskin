import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One Team row (spec 7 §6): two lines for every kind of row. Line 1 is the name and the time;
/// line 2 is the live status (typing, working, a tick on your last message) and the preview, with
/// the `@` and unread badges on the right. Groups add "{n} people · {names}" under the title. A
/// person with several conversations gets a chevron that expands them inline. The list gives the
/// row its 12 x 16 padding.
struct TeamRow: View {
	let row: TeamLayout.Row
	let status: ConversationRowStatus
	let currentActorID: String?
	/// "Now" for the time label; fixed in snapshot tests.
	var now = Date()
	var workingAgentIDs: Set<String> = []
	var expanded = false
	var onToggleExpanded: () -> Void = {}

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s7) {
			avatar.frame(width: ConversationRow.clusterWidth, height: ConversationRow.avatarSize)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(title)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: row.isUnread ? .bold : .semibold, relativeTo: .body))
					.tracking(-0.014 * MaskinFontSize.t16)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(2)
					.multilineTextAlignment(.leading)
				secondaryLine
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			// Time over the unread badge (or the expand chevron), right-aligned.
			VStack(alignment: .trailing, spacing: MaskinSpace.s4) {
				if let date = row.activityDate {
					Text(ChatListTime.label(for: date, now: now))
						.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
						.foregroundStyle(MaskinColor.inkPlaceholder)
						.lineLimit(1)
						.fixedSize()
				}
				// One badge per row: a mention outranks the unread count.
				if status.mentionsYou {
					CountBadge(text: "@").accessibilityLabel("Mentions you")
				} else if row.isUnread {
					UnreadBadge(count: row.unreadCount)
				}
				if canExpand { chevron }
			}
			.frame(minWidth: MaskinSpace.s14 - MaskinSpace.s4, alignment: .trailing)
		}
		.contentShape(Rectangle())
		.maskinHover()
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	/// The line under the title: who the chat is with (the agent's name), or the live status
	/// while someone types or works, or the latest message for rows that have no topic.
	@ViewBuilder
	private var secondaryLine: some View {
		if showsStatus {
			RowStatusLine(status: status, unread: row.isUnread)
		} else if let who = subtitle ?? role {
			Text(who)
				.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .medium, relativeTo: .footnote))
				.foregroundStyle(MaskinColor.ink4)
				.lineLimit(1)
		} else {
			RowStatusLine(status: status, unread: row.isUnread)
		}
	}

	private var showsStatus: Bool {
		switch status.prefix {
		case .typing, .working: true
		default: false
		}
	}

	// MARK: Pieces

	@ViewBuilder
	private var avatar: some View {
		switch row.kind {
		case .conversation(let c):
			ConversationAvatar(
				participants: c.others(excluding: currentActorID), size: ConversationRow.avatarSize,
				working: c.participants.contains { workingAgentIDs.contains($0.id) })
		case .person(let p):
			ConversationAvatar(
				participants: p.participants, size: ConversationRow.avatarSize,
				working: p.participants.contains { workingAgentIDs.contains($0.id) })
		case .flow:
			FlowTile(size: ConversationRow.avatarSize)
		}
	}

	private var title: String {
		switch row.kind {
		case .conversation(let c):
			if hasCustomTitle(c) { return ChatPreviewText.plain(c.title) }
			return TeamLayout.title(of: c, me: currentActorID)
		case .person(let p): return p.name
		case .flow(let f): return f.name
		}
	}

	/// A 1:1 conversation with its own title keeps the person's name beside it.
	private var role: String? {
		guard case .conversation(let c) = row.kind, !c.isGroupChat(excluding: currentActorID), hasCustomTitle(c)
		else { return nil }
		return c.others(excluding: currentActorID).first?.name
	}

	private var subtitle: String? {
		guard case .conversation(let c) = row.kind, c.isGroupChat(excluding: currentActorID) else { return nil }
		return TeamLayout.groupLine(c, me: currentActorID)
	}

	private func hasCustomTitle(_ c: ConversationSummary) -> Bool {
		guard !c.isGroupChat(excluding: currentActorID) else { return false }
		let names = c.others(excluding: currentActorID).map(\.name)
		let title = c.title.trimmingCharacters(in: .whitespacesAndNewlines)
		return !title.isEmpty && title != ThreadLayout.defaultTitle(for: names) && !names.contains(title)
	}

	private var canExpand: Bool {
		if case .person(let p) = row.kind { return p.hasSeveral }
		return false
	}

	/// 44×36 hit area; stops the tap from opening the row.
	private var chevron: some View {
		Button(action: onToggleExpanded) {
			Image(systemName: "chevron.right")
				.maskinSymbol(MaskinFontSize.t13, weight: .semibold)
				.foregroundStyle(MaskinColor.ink5)
				.rotationEffect(.degrees(expanded ? 90 : 0))
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin - MaskinSpace.s4)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.padding(.trailing, -MaskinSpace.s7)
		.padding(.vertical, -MaskinSpace.s4)
		.accessibilityLabel(expanded ? "Hide conversations" : "Show conversations")
	}

	private var accessibilityLabel: String {
		var parts = [title]
		if let role { parts.append(role) }
		if let subtitle { parts.append(subtitle) }
		parts.append(status.accessibilityText)
		if row.isUnread { parts.append("\(row.unreadCount) unread") }
		return parts.joined(separator: ", ")
	}
}

/// The prefix and preview of a row's second line.
struct RowStatusLine: View {
	let status: ConversationRowStatus
	var unread = false

	var body: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s4) {
			switch status.prefix {
			case .typing:
				Text("typing…")
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.sigInk)
			case .working:
				HStack(spacing: MaskinSpace.s3) {
					TeamWorkingBars()
					Text(status.workingText)
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
				}
				.foregroundStyle(MaskinColor.sigInk)
				.fixedSize()
				Text("·").foregroundStyle(MaskinColor.inkPlaceholder).fixedSize()
			case .tick(let tick):
				Text(tick.symbol)
					.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold, relativeTo: .caption))
					.foregroundStyle(tickColor(tick))
					.fixedSize()
			case nil:
				EmptyView()
			}
			if !status.preview.isEmpty {
				Text(status.preview)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
					.foregroundStyle(previewColor)
					.lineLimit(2)
					.multilineTextAlignment(.leading)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
	}

	private var previewColor: Color {
		if case .working = status.prefix { return MaskinColor.sigInk }
		return unread ? MaskinColor.ink2 : MaskinColor.ink4
	}

	private func tickColor(_ tick: ConversationRowStatus.Tick) -> Color {
		switch tick {
		case .sending, .sent: MaskinColor.ink5
		case .read: MaskinColor.sigInk
		case .failed: MaskinColor.danger
		}
	}
}

/// Three 2.5pt Patina bars that bob while an agent works; still under Reduce Motion.
struct TeamWorkingBars: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	private static let heights: [[CGFloat]] = [[5, 11, 7], [11, 6, 9], [7, 9, 11], [9, 5, 6]]

	var body: some View {
		if reduceMotion {
			bars(Self.heights[0])
		} else {
			PhaseAnimator(Self.heights) { heights in
				bars(heights)
			} animation: { _ in
				.easeInOut(duration: MaskinDuration.d200)
			}
		}
	}

	private func bars(_ heights: [CGFloat]) -> some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s1) {
			ForEach(0..<3, id: \.self) { i in
				RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous)
					.fill(MaskinColor.sig)
					.frame(width: 2.5, height: heights[i])
			}
		}
		.frame(height: MaskinFontSize.t11, alignment: .bottom)
		.accessibilityHidden(true)
	}
}

/// A flow room's 40pt tile: the flow icon on `sigTint`.
struct FlowTile: View {
	var size: CGFloat = ConversationRow.avatarSize
	var body: some View {
		Image(systemName: "arrow.triangle.2.circlepath")
			.maskinSymbol(size * 0.46, weight: .medium)
			.foregroundStyle(MaskinColor.sigInk)
			.frame(width: size, height: size)
			.background(MaskinColor.sigTint, in: RoundedRectangle(cornerRadius: size * 0.35, style: .continuous))
			.accessibilityHidden(true)
	}
}

/// A conversation row with the plain preview, for callers that only have the summary.
struct ConversationRow: View {
	let conversation: ConversationSummary
	let currentActorID: String?
	/// "Now" for the time label; fixed in snapshot tests.
	var now = Date()

	var body: some View {
		TeamRow(
			row: TeamLayout.Row(id: conversation.id, kind: .conversation(conversation)),
			status: ConversationRowStatus.make(conversation: conversation), currentActorID: currentActorID, now: now)
	}

	static let avatarSize: CGFloat = MaskinSpace.s14 + MaskinSpace.s4
	/// A group chat's two avatars sit in a 44 x 40 cluster.
	static let clusterWidth: CGFloat = MaskinSpace.s14 + MaskinSpace.s7
}

/// The unread count: `badge` fill, `badgeFg` label, 18pt minimum, radius 9.
struct UnreadBadge: View {
	let count: Int
	var body: some View {
		CountBadge(text: count > 99 ? "99+" : "\(count)")
			.accessibilityHidden(true)
	}
}

struct CountBadge: View {
	let text: String
	var body: some View {
		Text(text)
			.font(MaskinTypeface.sans(MaskinFontSize.t11, weight: .bold, relativeTo: .caption2))
			.foregroundStyle(MaskinColor.badgeFg)
			.padding(.horizontal, MaskinSpace.s3 - 1)
			.frame(minWidth: MaskinSpace.s10, minHeight: MaskinSpace.s10)
			.background(MaskinGradient.badge, in: Capsule())
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
