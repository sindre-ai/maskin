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
							.contextMenu { menu(for: conversation) }
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
		.refreshable { await store.refresh() }
		.searchable(text: $search, prompt: "Search chats")
		.navigationTitle(store.scope == .archived ? "Archived" : "Chats")
		.toolbar {
			ToolbarItem(placement: .automatic) { AgentFilterMenu(store: store) }
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
						title: store.scope == .archived ? "Nothing archived" : "No conversations yet",
						message: store.scope == .archived ? nil : "Start one with a teammate or an agent."
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

/// Narrows the list to conversations with one agent. Hidden until the list has agents in it.
private struct AgentFilterMenu: View {
	@Bindable var store: ConversationsStore

	var body: some View {
		let agents = store.agentsInList
		if !agents.isEmpty {
			Menu {
				Picker("Agent", selection: $store.agentFilterID) {
					Text("All agents").tag(String?.none)
					ForEach(agents) { agent in Text(agent.name).tag(String?.some(agent.id)) }
				}
			} label: {
				Label(
					"Filter by agent",
					systemImage: store.agentFilterID == nil
						? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
			}
		}
	}
}
