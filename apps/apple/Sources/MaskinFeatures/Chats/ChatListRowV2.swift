import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One chat in the new list (chat list design spec v12 and its states addendum): three lines like
/// Apple Mail. Line 1 is the agent names and the time, line 2 the chat title, line 3 the preview
/// (one line). A direct message has no title, so it has two lines. The row dot is for unread only. The preview line carries at most one marker,
/// in the order error, needs you, working; nothing animates.
struct ChatListRowV2: View {
	let conversation: ConversationSummary
	let currentActorID: String?
	/// "Now" for the time label; fixed in snapshot tests.
	var now = Date()

	private var others: [ChatParticipant] { conversation.others(excluding: currentActorID) }

	private var names: String {
		let shown = others
		return shown.isEmpty ? conversation.title : shown.map(\.name).joined(separator: ", ")
	}

	/// A direct message has no topic of its own, so it shows no title line.
	private var title: String? {
		conversation.isDirect ? nil : ChatPreviewText.plain(conversation.title)
	}

	private var workingNames: [String] {
		let ids = Set(conversation.workingAgentIDs)
		return conversation.participants.filter { ids.contains($0.id) }.map(\.name)
	}

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			unreadDot
			ConversationAvatar(
				participants: others, size: ConversationRow.avatarSize, working: false)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
					Text(names)
						.font(
							MaskinTypeface.sans(
								MaskinFontSize.t17, weight: conversation.isUnread ? .bold : .semibold, relativeTo: .body)
						)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					Spacer(minLength: MaskinSpace.s3)
					if conversation.pinned {
						Text("Pinned").maskinText(.caption).foregroundStyle(MaskinColor.inkPlaceholder).fixedSize()
					}
					if let date = conversation.activityDate {
						Text(ChatListTime.label(for: date, now: now))
							.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
							.foregroundStyle(MaskinColor.inkPlaceholder)
							.lineLimit(1)
							.fixedSize()
					}
				}
				if let title {
					Text(title)
						.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .medium, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
				}
				previewLine
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(accessibilityLabel)
	}

	// MARK: Pieces

	/// The blue dot: unread only, 7pt, in the row's gutter.
	private var unreadDot: some View {
		Circle()
			.fill(conversation.isUnread ? MaskinColor.sig : Color.clear)
			.frame(width: Self.dot, height: Self.dot)
			.padding(.top, MaskinSpace.s5)
			.accessibilityHidden(true)
	}

	@ViewBuilder
	private var previewLine: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s3) {
			switch conversation.previewMarker {
			case .error(let reason):
				Circle().fill(MaskinColor.danger).frame(width: Self.markerDot, height: Self.markerDot)
					.padding(.top, MaskinSpace.s3).accessibilityHidden(true)
				Text(reason.line)
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .medium, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.danger)
					.lineLimit(1)
			case .needsYou:
				Circle().fill(MaskinColor.warning).frame(width: Self.markerDot, height: Self.markerDot)
					.padding(.top, MaskinSpace.s3).accessibilityHidden(true)
				previewText.fontWeight(.medium).foregroundStyle(MaskinColor.ink).lineLimit(1)
			case .working:
				// A still ring with the top edge in ink: no animation in the list.
				Circle()
					.strokeBorder(MaskinColor.ink5, lineWidth: 1.5)
					.overlay {
						// The top quarter of the ring in ink.
						Circle().inset(by: 0.75).trim(from: 0.625, to: 0.875)
							.stroke(MaskinColor.ink, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
					}
					.frame(width: Self.ring, height: Self.ring)
					.padding(.top, MaskinSpace.s2).accessibilityHidden(true)
				Text(workingText).font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink4).lineLimit(1)
			case nil:
				previewText.foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
		}
		.multilineTextAlignment(.leading)
	}

	private var previewText: Text {
		let pieces = conversation.snippet.map(ChatPreviewText.linePieces) ?? []
		guard !pieces.isEmpty else { return Text(ConversationRowStatus.noMessages) }
		return ChatPreviewLine.text("", pieces: pieces).font(
			MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
	}

	/// "Forge is working…", "Forge, Sage are working…".
	private var workingText: String {
		let names = workingNames
		guard !names.isEmpty else { return "Working…" }
		return "\(names.joined(separator: ", ")) \(names.count == 1 ? "is" : "are") working…"
	}

	/// What a screen reader hears: the marker as words, never only a colour.
	private var accessibilityLabel: String {
		var parts = [names] + (title.map { [$0] } ?? [])
		switch conversation.previewMarker {
		case .error(let reason): parts.append(reason.accessibilityLabel)
		case .needsYou: parts.append("Needs you")
		case .working: parts.append(workingText)
		case nil: break
		}
		if let snippet = conversation.snippet, conversation.previewMarker == nil || conversation.previewMarker == .needsYou {
			parts.append(ChatPreviewText.plain(snippet))
		}
		if conversation.isUnread { parts.append("Unread") }
		if conversation.pinned { parts.append("Pinned") }
		return parts.joined(separator: ", ")
	}

	static let dot: CGFloat = 7
	static let markerDot: CGFloat = 8
	static let ring: CGFloat = 11
}

/// The pills above the list: All, Needs you, Unread, Working, Later. 32pt pills with a 44pt tap
/// area; the selected one is filled ink with inverted text; the others show their count when it is
/// above 0. They scroll sideways in one row.
struct ChatListPills: View {
	@Binding var filter: ChatListFilter
	let counts: [ChatListFilter: Int]

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4 - 1) {
				ForEach(ChatListFilter.allCases) { pill in
					pillButton(pill)
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
		}
		.scrollClipDisabled()
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Filter chats")
	}

	@ViewBuilder
	private func pillButton(_ pill: ChatListFilter) -> some View {
		let on = pill == filter
		let count = pill == .all ? 0 : (counts[pill] ?? 0)
		Button {
			MaskinHaptics.play(.selection)
			filter = pill
		} label: {
			HStack(spacing: MaskinSpace.s4 - 1) {
				Text(pill.label)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
				if !on, count > 0 {
					Text("\(count)")
						.font(MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold, relativeTo: .caption2))
						.foregroundStyle(MaskinColor.ink4)
				}
			}
			.foregroundStyle(on ? MaskinSurface.onInverse : MaskinColor.ink2)
			.padding(.horizontal, MaskinSpace.s8)
			.frame(height: Self.height)
			.background(on ? MaskinSurface.inverse : MaskinSurface.card, in: Capsule())
			// The pill is 32pt; the tap area is 44pt.
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityAddTraits(on ? [.isSelected] : [])
		.accessibilityLabel(count > 0 && !on ? "\(pill.label), \(count)" : pill.label)
		.id(pill)
	}

	static let height: CGFloat = 32
}

/// A group heading: a plain label, no count.
struct ChatListGroupHeader: View {
	let label: String

	var body: some View {
		Text(label)
			.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
			.foregroundStyle(MaskinColor.ink)
			.textCase(nil)
			.padding(.top, MaskinSpace.s12)
			.accessibilityAddTraits(.isHeader)
	}
}

/// Six rows of placeholders at the row height, shown while the first page loads. The pills draw at
/// once with no counts.
struct ChatListSkeleton: View {
	var body: some View {
		VStack(spacing: 0) {
			ForEach(0..<6, id: \.self) { _ in
				HStack(alignment: .top, spacing: MaskinSpace.s7) {
					RoundedRectangle(cornerRadius: ConversationRow.avatarSize * 0.3, style: .continuous)
						.fill(MaskinSurface.fill)
						.frame(width: ConversationRow.avatarSize, height: ConversationRow.avatarSize)
					VStack(alignment: .leading, spacing: MaskinSpace.s4) {
						SkeletonBlock(height: MaskinSpace.s8).containerRelativeFrame(.horizontal) { w, _ in w * 0.5 }
						SkeletonBlock(height: MaskinSpace.s7).containerRelativeFrame(.horizontal) { w, _ in w * 0.35 }
						SkeletonBlock(height: MaskinSpace.s7).frame(maxWidth: .infinity)
					}
				}
				.padding(.vertical, MaskinSpace.s7)
				.padding(.horizontal, MaskinSpace.s9)
			}
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("Loading chats")
	}
}
