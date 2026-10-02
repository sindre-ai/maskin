import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The sidebar column: grouped conversations with search, swipe actions, and loading, empty and
/// offline states.
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
							.swipeActions(edge: .trailing, allowsFullSwipe: true) {
								Button {
									Task { await store.setArchived(conversation.id, !conversation.archived) }
								} label: {
									Label(conversation.archived ? "Unarchive" : "Archive", systemImage: "archivebox")
								}
								.tint(MaskinColor.ink4)
							}
							.swipeActions(edge: .leading) {
								Button {
									Task { await store.setPinned(conversation.id, !conversation.pinned) }
								} label: {
									Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin")
								}
								.tint(MaskinColor.accent)
								Button {
									Task {
										if conversation.isUnread {
											await store.markRead(conversation.id, upTo: nil, serverAlreadyKnows: false)
										} else {
											await store.markUnread(conversation.id)
										}
									}
								} label: {
									Label(conversation.isUnread ? "Read" : "Unread", systemImage: conversation.isUnread ? "envelope.open" : "envelope.badge")
								}
							}
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
		.navigationTitle(store.scope == .archived ? "Archived" : (store.filter == .unread ? "Unread" : (store.filter == .pinned ? "Pinned" : "Chats")))
		.toolbar {
			ToolbarItem(placement: .automatic) {
				Menu {
					Picker(
						"Show",
						selection: Binding(get: { store.filter }, set: { store.filter = $0 })
					) {
						Text("All").tag(ConversationsStore.Filter.all)
						Text("Unread").tag(ConversationsStore.Filter.unread)
						Text("Pinned").tag(ConversationsStore.Filter.pinned)
					}
					.disabled(store.scope == .archived)
					Toggle(
						"Archived",
						isOn: Binding(
							get: { store.scope == .archived },
							set: { store.scope = $0 ? .archived : .active }))
				} label: {
					Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
				}
			}
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
						title: emptyTitle,
						message: store.scope == .archived || store.filter != .all
							? nil : "Start one with a teammate or an agent."
					) {
						if store.scope == .active, store.filter == .all {
							Button("New chat", action: onNewChat).buttonStyle(.primaryAction)
						}
					}
				} else {
					ContentUnavailableView.search(text: search)
				}
			}
		}
	}

	private var emptyTitle: String {
		if store.scope == .archived { return "Nothing archived" }
		switch store.filter {
		case .all: return "No conversations yet"
		case .unread: return "You're all caught up"
		case .pinned: return "Nothing pinned"
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
