import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Every thread you started or replied in, across your chats: NEW (replies you have not read),
/// then EARLIER. A row names the chat the thread lives in, the newest line and the reply count.
struct ThreadsListScreen: View {
	let store: ConversationsStore
	let onOpen: (ThreadListItem) -> Void

	var body: some View {
		let sections = store.threadSections
		Group {
			if sections.isEmpty {
				EmptyState(
					symbol: "text.bubble", title: "No threads yet",
					message: "Reply in a thread from a message's menu. Threads you are in show up here.")
			} else {
				ScrollView {
					VStack(alignment: .leading, spacing: MaskinSpace.s9) {
						section("New", items: sections.new)
						section("Earlier", items: sections.earlier)
					}
					.padding(.horizontal, MaskinSpace.s9)
					.padding(.vertical, MaskinSpace.s5)
				}
			}
		}
		.background(MaskinSurface.grouped)
		.navigationTitle("Threads")
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.task { await store.refreshThreads() }
		.refreshable { await store.refreshThreads() }
	}

	@ViewBuilder
	private func section(_ title: String, items: [ThreadListItem]) -> some View {
		if !items.isEmpty {
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				TeamSectionHeader(label: title.uppercased(), count: nil).padding(.horizontal, MaskinSpace.s2)
				VStack(spacing: 0) {
					ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
						if index > 0 { Divider().overlay(MaskinSurface.separator) }
						Button { onOpen(item) } label: { ThreadListRow(item: item) }
							.buttonStyle(.maskinPressed)
					}
				}
				.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
				.overlay(
					RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)
						.strokeBorder(MaskinSurface.line, lineWidth: 1))
			}
		}
	}
}

struct ThreadListRow: View {
	let item: ThreadListItem
	var now = Date()

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s6) {
			ActorAvatar(
				name: item.root.actorName, kind: item.root.author == .agent ? .agent : .human,
				size: MaskinSpace.s14 + MaskinSpace.s4, seed: item.root.actorID
			)
			.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
					Text(ChatPreviewText.plain(item.conversationTitle))
						.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold, relativeTo: .body))
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
					Spacer(minLength: MaskinSpace.s3)
					if let date = item.activityDate {
						Text(ChatListTime.label(for: date, now: now))
							.maskinText(.caption).foregroundStyle(MaskinColor.inkPlaceholder).fixedSize()
					}
				}
				Text(item.snippet)
					.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink2)
					.lineLimit(2)
					.multilineTextAlignment(.leading)
				HStack(spacing: MaskinSpace.s4) {
					Text(ThreadSummary.label(count: item.summary.replyCount, unread: 0))
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .bold, relativeTo: .footnote))
						.foregroundStyle(MaskinColor.sigInk)
					if item.isUnread {
						Text("\(item.summary.unreadCount) new")
							.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .bold, relativeTo: .caption))
							.foregroundStyle(MaskinSurface.onInverse)
							.padding(.horizontal, MaskinSpace.s4)
							.frame(height: MaskinSpace.s11)
							.background(MaskinSurface.inverse, in: Capsule())
					}
				}
			}
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.vertical, MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(
			"\(item.conversationTitle). \(item.snippet). \(ThreadSummary.label(count: item.summary.replyCount, unread: item.summary.unreadCount))"
		)
	}
}

/// The Threads row at the top of Team when the filter chips (which carry their own Threads chip)
/// are off: an icon, "Threads", how many have unread replies, and a chevron.
struct ThreadsEntryRow: View {
	let unread: Int
	let onOpen: () -> Void

	var body: some View {
		Button {
			MaskinHaptics.play(.selection)
			onOpen()
		} label: {
			HStack(spacing: MaskinSpace.s7) {
				Image(systemName: "bubble.left.and.text.bubble.right")
					.maskinSymbol(MaskinFontSize.t15, weight: .medium)
					.foregroundStyle(MaskinColor.ink3)
					.frame(width: MaskinSpace.s14 + MaskinSpace.s1, height: MaskinSpace.s14 + MaskinSpace.s1)
					.background(MaskinSurface.fill, in: Circle())
					.accessibilityHidden(true)
				Text("Threads")
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold, relativeTo: .body))
					.foregroundStyle(MaskinColor.ink)
				Spacer(minLength: MaskinSpace.s4)
				if unread > 0 { UnreadBadge(count: unread) }
				Image(systemName: "chevron.right")
					.maskinSymbol(MaskinFontSize.t13, weight: .semibold)
					.foregroundStyle(MaskinColor.inkPlaceholder)
			}
			.padding(.horizontal, MaskinSpace.s8 + 1)
			.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s4)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadiusLarge.tile, style: .continuous))
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityLabel(unread > 0 ? "Threads, \(unread) with new replies" : "Threads")
	}
}
