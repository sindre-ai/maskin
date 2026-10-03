import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The sidebar column: grouped conversations with search, a New chat button, and loading,
/// empty and offline states. Pin, archive and unread live in the long-press menu.
struct ConversationListView: View {
	let store: ConversationsStore
	@Binding var selection: String?
	@Binding var search: String
	let currentActorID: String?
	var isLive = true
	let onNewChat: () -> Void

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
							.listRowSeparator(.hidden)
							.contextMenu { menu(for: conversation) }
							.swipeActions(edge: .leading, allowsFullSwipe: true) {
								Button {
									MaskinHaptics.play(.selection)
									Task { await store.setPinned(conversation.id, !conversation.pinned) }
								} label: {
									Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin")
								}
								.tint(MaskinColor.accent)
							}
							.swipeActions(edge: .trailing, allowsFullSwipe: true) {
								Button {
									MaskinHaptics.play(.selection)
									Task { await store.setArchived(conversation.id, !conversation.archived) }
								} label: {
									Label(conversation.archived ? "Unarchive" : "Archive", systemImage: "archivebox")
								}
								.tint(MaskinColor.ink3)
							}
							.onAppear {
								if conversation.id == store.conversations.last?.id { Task { await store.loadMore() } }
							}
					}
				} header: {
					MonoLabel(group.label)
				}
			}
			if search.isEmpty, !store.conversations.isEmpty || store.scope == .archived {
				Button(store.scope == .archived ? "Back to chats" : "Archived") {
					store.scope = store.scope == .archived ? .active : .archived
				}
				.foregroundStyle(MaskinColor.ink4)
			}
		}
		.listStyle(.plain)
		.overlay { overlay(isEmpty: groups.isEmpty) }
		.characterRefreshable { await store.refresh() }
		.chatSearch(store: store, text: $search)
		.toolbar {
			ToolbarItem(placement: .automatic) {
				Button(action: onNewChat) { Label("New chat", systemImage: "square.and.pencil") }
					.keyboardShortcut("n", modifiers: .command)
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
						title: store.scope == .archived ? "Nothing archived" : "A quiet inbox",
						message: store.scope == .archived ? nil : "Start a chat with a teammate or an agent."
					) {
						if store.scope == .active {
							Button("New chat", action: onNewChat).buttonStyle(.primaryAction)
						}
					}
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

extension View {
	/// Search as a toolbar icon that expands into the field (iOS 26; a regular search field
	/// below). Agents are filter tokens inside it, so there's no separate filter button: type
	/// to narrow the list, or pick an agent from the suggestions to keep only its chats.
	fileprivate func chatSearch(store: ConversationsStore, text: Binding<String>) -> some View {
		modifier(ChatSearchModifier(store: store, text: text))
	}
}

private struct ChatSearchModifier: ViewModifier {
	@Bindable var store: ConversationsStore
	@Binding var text: String

	/// The one selected agent as a token (the store holds an id; the token needs the person).
	private var tokens: Binding<[ChatParticipant]> {
		Binding(
			get: { store.agentsInList.filter { $0.id == store.agentFilterID } },
			set: { store.agentFilterID = $0.last?.id })
	}

	func body(content: Content) -> some View {
		content
			.searchable(text: $text, tokens: tokens, prompt: "Search chats") { agent in
				Label(agent.name, systemImage: ActorIdentity.agentSymbol(seed: agent.id))
			}
			.searchSuggestions {
				if store.agentFilterID == nil {
					ForEach(store.agentsInList.filter(matches)) { agent in
						Label(agent.name, systemImage: ActorIdentity.agentSymbol(seed: agent.id))
							.searchCompletion(agent)
					}
				}
			}
			.searchMinimized()
	}

	private func matches(_ agent: ChatParticipant) -> Bool {
		text.trimmingCharacters(in: .whitespaces).isEmpty
			|| agent.name.localizedCaseInsensitiveContains(text)
	}
}
