import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The sidebar column: grouped conversations with search, a bottom bar that starts a chat, and
/// loading, empty and offline states. Pin, archive and unread live in the long-press menu.
struct ConversationListView: View {
	let store: ConversationsStore
	@Binding var selection: String?
	@Binding var search: String
	let currentActorID: String?
	var isLive = true
	/// Called with the text typed in the bottom bar; the host picks who the chat is with.
	let onStart: (String) -> Void

	var body: some View {
		let groups = store.groups(query: search)
		List(selection: $selection) {
			if !isLive {
				OfflineBanner(message: "Live updates paused. Reconnecting…")
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			ForEach(groups) { group in
				Section {
					ForEach(group.items) { conversation in
						ConversationRow(conversation: conversation, currentActorID: currentActorID)
							.tag(conversation.id)
							.contextMenu { menu(for: conversation) }
							.onAppear {
								if conversation.id == store.conversations.last?.id { Task { await store.loadMore() } }
							}
					}
				} header: {
					MonoLabel(group.label)
				}
			}
		}
		.listStyle(.plain)
		.overlay { overlay(isEmpty: groups.isEmpty) }
		.refreshable { await store.refresh() }
		.searchable(text: $search, prompt: "Search chats")
		.navigationTitle(store.scope == .archived ? "Archived" : "Chats")
		.safeAreaInset(edge: .bottom, spacing: 0) {
			if store.scope == .active {
				NewChatBar(onSend: onStart)
			} else {
				Button("Back to chats") { store.scope = .active }
					.buttonStyle(.secondaryAction).padding(MaskinSpace.s5)
			}
		}
	}

	@ViewBuilder
	private func overlay(isEmpty: Bool) -> some View {
		switch store.phase {
		case .idle, .loading:
			if store.conversations.isEmpty { LoadingSkeleton(rows: 4).padding(MaskinSpace.s9) }
		case .failed(let message):
			EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load chats", message: message) {
				Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			if isEmpty {
				if search.isEmpty {
					EmptyState(
						symbol: "bubble.left.and.bubble.right",
						title: store.scope == .archived ? "Nothing archived" : "No conversations yet",
						message: store.scope == .archived ? nil : "Ask anything below to start one.")
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}

	@ViewBuilder
	private func menu(for conversation: ConversationSummary) -> some View {
		Button(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin") {
			Task { await store.setPinned(conversation.id, !conversation.pinned) }
		}
		Button("Mark as unread", systemImage: "envelope.badge") {
			Task { await store.markUnread(conversation.id) }
		}
		Button(conversation.archived ? "Unarchive" : "Archive", systemImage: "archivebox") {
			Task { await store.setArchived(conversation.id, !conversation.archived) }
		}
	}
}

/// One field and a send arrow, pinned under the list. Typing here is how a chat starts.
private struct NewChatBar: View {
	let onSend: (String) -> Void
	@State private var text = ""

	private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

	var body: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s4) {
			TextField("Ask anything", text: $text, axis: .vertical)
				.lineLimit(1...4)
				.maskinText(.body)
				.frame(minHeight: MaskinSpace.touchMin)
				.padding(.leading, MaskinSpace.s4)
			Button {
				MaskinHaptics.play(.light)
				onSend(trimmed)
				text = ""
			} label: {
				Image(systemName: "arrow.up")
					.font(.system(size: MaskinFontSize.t15, weight: .bold))
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.background(MaskinSurface.inverse, in: Circle())
					.opacity(trimmed.isEmpty ? 0.35 : 1)
			}
			.buttonStyle(.plain)
			.disabled(trimmed.isEmpty)
			.accessibilityLabel("Start chat")
		}
		.padding(MaskinSpace.s3)
		.maskinGlass(in: RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s4, style: .continuous))
		.padding(.horizontal, MaskinSpace.s5).padding(.bottom, MaskinSpace.s3)
	}
}
