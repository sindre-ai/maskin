import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The sidebar column: pinned chats as tiles, then conversations in inset cards by day (or by
/// agent), with search, a New chat button, a Display menu and loading, empty and offline states.
/// Swipe left archives; pin, archive and unread also live in the long-press menu.
struct ConversationListView: View {
	let store: ConversationsStore
	@Binding var selection: String?
	@Binding var search: String
	let currentActorID: String?
	var isLive = true
	let onNewChat: () -> Void

	@State private var picking = SelectionModel()

	@AppStorage(ChatsDisplayMenu.groupByKey) private var storedGroupBy = ConversationGroupBy.recent.rawValue

	var body: some View {
		let sections = store.sections(query: search, currentActorID: currentActorID)
		let allIDs = sections.pinned.map(\.id) + sections.groups.flatMap { $0.items.map(\.id) }
		// While selecting, a tap toggles the row instead of opening it.
		let rowSelection = Binding<String?>(
			get: { picking.isActive ? nil : selection },
			set: { id in
				if picking.isActive {
					if let id { picking.toggle(id) }
				} else {
					selection = id
				}
			})
		return List(selection: rowSelection) {
			if !isLive {
				OfflineBanner(message: "Live updates paused. Reconnecting…")
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			if !sections.pinned.isEmpty {
				PinnedTiles(
					conversations: sections.pinned, currentActorID: currentActorID, selection: rowSelection,
					picking: picking.isActive ? picking : nil,
					onUnpin: { id in Task { await store.setPinned(id, false) } }
				)
				.listRowInsets(EdgeInsets(top: 0, leading: MaskinSpace.s9, bottom: MaskinSpace.s4, trailing: MaskinSpace.s9))
				.listRowBackground(Color.clear)
				.listRowSeparator(.hidden)
			}
			ForEach(sections.groups) { group in
				Section {
					ForEach(group.items) { conversation in
						HStack(spacing: MaskinSpace.s5) {
							if picking.isActive {
								SelectionCheckbox(isPicked: picking.contains(conversation.id))
									.transition(.move(edge: .leading).combined(with: .opacity))
							}
							ConversationRow(conversation: conversation, currentActorID: currentActorID)
						}
						.selectionRowAccessibility(
							isActive: picking.isActive, isPicked: picking.contains(conversation.id))
							.tag(conversation.id)
							.listRowBackground(MaskinSurface.card)
							.listRowSeparatorTint(MaskinSurface.separator)
							.contextMenu { if !picking.isActive { menu(for: conversation) } }
							.swipeActions(edge: .leading, allowsFullSwipe: true) {
								if !picking.isActive { Button {
									MaskinHaptics.play(.selection)
									Task { await store.setPinned(conversation.id, !conversation.pinned) }
								} label: {
									Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin")
								}
								.tint(MaskinColor.ink) }
							}
							.swipeActions(edge: .trailing, allowsFullSwipe: true) {
								if !picking.isActive { Button {
									MaskinHaptics.play(.selection)
									Task { await store.setArchived(conversation.id, !conversation.archived) }
								} label: {
									Label(conversation.archived ? "Unarchive" : "Archive", systemImage: "archivebox")
								}
								.tint(MaskinColor.ink3) }
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
				.listRowBackground(Color.clear)
			}
		}
		#if os(iOS)
		.listStyle(.insetGrouped)
		#else
		.listStyle(.inset)
		#endif
		.scrollContentBackground(.hidden)
		.ambientBackground()
		.overlay { overlay(isEmpty: sections.isEmpty) }
		.refreshable { await store.refresh() }
		.animation(.snappy, value: picking.isActive)
		.onChange(of: allIDs) { picking.prune(toVisible: allIDs) }
		.onChange(of: store.scope) { picking.exit() }
		.selectionToolbar(picking, allIDs: allIDs, noun: "chat") { bulkActions(allIDs: allIDs) }
		.chatSearch(store: store, text: $search)
		.onAppear { store.groupBy = ConversationGroupBy(rawValue: storedGroupBy) ?? .recent }
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

	/// Bulk actions in the selection bar. Archive is the primary; the rest sit in a text menu.
	@ViewBuilder
	private func bulkActions(allIDs: [String]) -> some View {
		let ids = picking.ordered(in: allIDs)
		Menu("More") {
			if store.scope == .active {
				Button("Pin", systemImage: "pin") { run(ids) { await store.setPinned($0, true) } }
				Button("Unpin", systemImage: "pin.slash") { run(ids) { await store.setPinned($0, false) } }
				Button("Mark as unread", systemImage: "envelope.badge") { run(ids) { await store.markUnread($0) } }
			}
		}
		.disabled(picking.isEmpty || store.scope != .active)
		Button(store.scope == .archived ? "Unarchive" : "Archive") {
			run(ids) { await store.setArchived($0, store.scope != .archived) }
		}
		.fontWeight(.semibold)
		.disabled(picking.isEmpty)
	}

	private func run(_ ids: [String], _ action: @escaping ([String]) async -> BulkResult) {
		MaskinHaptics.play(.selection)
		picking.exit()
		Task { _ = await action(ids) }
	}

	@ViewBuilder
	private func menu(for conversation: ConversationSummary) -> some View {
		Button(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin") {
			Task { await store.setPinned(conversation.id, !conversation.pinned) }
		}
		Button("Mark as unread", systemImage: "envelope.badge") {
			Task { await store.markUnread(conversation.id) }
		}
		Button("Select", systemImage: "checkmark.circle") { picking.enter(selecting: conversation.id) }
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
	@State private var presented = false

	/// The one selected agent as a token (the store holds an id; the token needs the person).
	private var tokens: Binding<[ChatParticipant]> {
		Binding(
			get: { store.agentsInList.filter { $0.id == store.agentFilterID } },
			set: { store.agentFilterID = $0.last?.id })
	}

	func body(content: Content) -> some View {
		content
			.searchable(text: $text, tokens: tokens, isPresented: $presented, prompt: "Search chats") {
				agent in
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
			// Closing the field collapses it back to the icon; a leftover agent token or query
			// would otherwise keep it open.
			.onChange(of: presented) {
				guard !presented else { return }
				text = ""
				store.agentFilterID = nil
			}
	}

	private func matches(_ agent: ChatParticipant) -> Bool {
		text.trimmingCharacters(in: .whitespaces).isEmpty
			|| agent.name.localizedCaseInsensitiveContains(text)
	}
}

/// Pinned chats: a three-column grid of tiles (the agent's avatar, its name and the chat's title).
/// A pinned chat is not listed again below.
struct PinnedTiles: View {
	let conversations: [ConversationSummary]
	let currentActorID: String?
	@Binding var selection: String?
	/// Non-nil while the list is in selection mode: tiles show their checkmark.
	var picking: SelectionModel?
	let onUnpin: (String) -> Void

	private let columns = Array(
		repeating: GridItem(.flexible(), spacing: MaskinSpace.s5, alignment: .top), count: 3)

	var body: some View {
		LazyVGrid(columns: columns, spacing: MaskinSpace.s5) {
			ForEach(conversations) { conversation in
				Button {
					selection = conversation.id
				} label: {
					PinnedTile(conversation: conversation, currentActorID: currentActorID)
						.overlay(alignment: .topLeading) {
							if let picking {
								SelectionCheckbox(isPicked: picking.contains(conversation.id)).padding(MaskinSpace.s4)
							}
						}
				}
				.buttonStyle(.plain)
				.contextMenu {
					if picking == nil {
						Button("Unpin", systemImage: "pin.slash") { onUnpin(conversation.id) }
					}
				}
			}
		}
		.accessibilityElement(children: .contain)
	}
}

struct PinnedTile: View {
	let conversation: ConversationSummary
	let currentActorID: String?

	var body: some View {
		let others = conversation.others(excluding: currentActorID)
		VStack(spacing: MaskinSpace.s3) {
			ConversationAvatar(participants: others, size: Self.avatarSize)
				.frame(height: Self.avatarSize)
				.padding(.top, MaskinSpace.s5)
			Text(conversation.counterpartName(excluding: currentActorID))
				.maskinText(.subhead).fontWeight(.bold)
				.foregroundStyle(MaskinColor.ink).lineLimit(1)
			Text(ChatPreviewText.plain(conversation.title))
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink4)
				.multilineTextAlignment(.center)
				.lineLimit(2, reservesSpace: true)
				.padding(.bottom, MaskinSpace.s5)
		}
		.padding(.horizontal, MaskinSpace.s4)
		.frame(maxWidth: .infinity)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadiusLarge.tile, style: .continuous))
		.overlay(alignment: .topTrailing) {
			if conversation.isUnread {
				UnreadBadge(count: conversation.unreadCount).padding(MaskinSpace.s4)
			}
		}
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel(
			"\(conversation.counterpartName(excluding: currentActorID)), \(ChatPreviewText.plain(conversation.title))"
				+ (conversation.isUnread ? ", \(conversation.unreadCount) unread" : ""))
		.accessibilityAddTraits(.isButton)
	}

	/// 54pt: the tile's avatar.
	static let avatarSize: CGFloat = MaskinSpace.s14 + MaskinSpace.s11 + MaskinSpace.s1
}


/// The Chats Display menu in the shell's pill: how the list is grouped. The choice is remembered.
struct ChatsDisplayMenu: View {
	static let groupByKey = "chats.groupBy"
	let store: ConversationsStore
	@AppStorage(Self.groupByKey) private var storedGroupBy = ConversationGroupBy.recent.rawValue

	var body: some View {
		Picker(
			"Group by",
			selection: Binding(
				get: { store.groupBy },
				set: {
					store.groupBy = $0
					storedGroupBy = $0.rawValue
				})
		) {
			ForEach(ConversationGroupBy.allCases) { Text($0.title).tag($0) }
		}
	}
}
