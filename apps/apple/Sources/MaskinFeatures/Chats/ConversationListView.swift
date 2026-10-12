import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Team list: pinned chats as tiles, then UNREAD (one row per person or agent) over every conversation in day groups, or, as "One list", every conversation in inset cards by day. Search, a New chat button,
/// a Display menu and loading, empty and offline states. Swipe left archives; pin, archive and
/// unread also live in the long-press menu.
struct ConversationListView: View {
	let store: ConversationsStore
	@Binding var selection: String?
	@Binding var search: String
	let currentActorID: String?
	var isLive = true
	let onNewChat: () -> Void
	/// Where the dragged order of the pinned tiles is kept (per user); nil keeps the server order.
	var pinnedOrder: PinnedOrderStore?

	@State private var picking = SelectionModel()
	@State private var undoOffer: UndoOffer?
	/// The row whose "More" was swiped open: its menu shows as a dialog.
	@State private var moreFor: ConversationSummary?
	@State private var savedPinnedOrder: [String] = []

	/// The filter chips are off until the Display menu turns them on.
	@AppStorage(ChatsDisplayMenu.chipsKey) private var showsChips = false

	/// People with several conversations whose rows are open, keyed by section and person.
	@State private var expanded: Set<String> = []

	@AppStorage(ChatsDisplayMenu.groupByKey) private var storedGroupBy = ConversationGroupBy.time.rawValue

	var body: some View {
		let sections = store.sections(query: search)
		// Selecting works on single conversations, so it shows the one-list layout.
		let team =
			store.groupBy != .recent && !picking.isActive
			? store.teamSections(query: search, currentActorID: currentActorID) : nil
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
			if showsChips {
				ConversationChipRow(selected: Binding(get: { store.chip }, set: { store.chip = $0 }), unread: store.conversations.filter(\.isUnread).count)
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			if let team {
				teamContent(team, groups: sections.groups, selection: rowSelection)
			} else {
				pinnedTiles(sections.pinned, selection: rowSelection)
				flatGroups(sections.groups)
			}
			if search.isEmpty, store.chip == .all, !store.conversations.isEmpty || store.scope == .archived {
				archivedRow
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
		.undoToast($undoOffer)
		.chatSearch(store: store, text: $search)
		.onAppear {
			store.groupBy = ConversationGroupBy(rawValue: storedGroupBy) ?? .time
			store.currentActorID = currentActorID
			savedPinnedOrder = pinnedOrder?.ids ?? []
		}
		// Turning the chips off also clears any filter they set.
		.onChange(of: showsChips) { _, on in if !on { store.chip = .all } }
		.confirmationDialog(
			moreFor.map { ChatPreviewText.plain($0.title) } ?? "", isPresented: Binding(get: { moreFor != nil }, set: { if !$0 { moreFor = nil } }),
			titleVisibility: .visible, presenting: moreFor
		) { conversation in
			menu(for: conversation)
		}
	}

	/// "Archived" at the bottom of the list: tapping swaps the list for the archived chats.
	private var archivedRow: some View {
		Button {
			store.scope = store.scope == .archived ? .active : .archived
		} label: {
			HStack(spacing: MaskinSpace.s5) {
				Image(systemName: "archivebox").foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
				Text(store.scope == .archived ? "Back to chats" : "Archived")
					.maskinText(.body).fontWeight(.semibold).foregroundStyle(MaskinColor.ink2)
				Spacer(minLength: 0)
				Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
					.foregroundStyle(MaskinColor.ink5).accessibilityHidden(true)
			}
			.frame(minHeight: MaskinSpace.s14 + MaskinSpace.s14 - MaskinSpace.s11)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.listRowBackground(MaskinSurface.card)
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
			if isEmpty { emptyState }
		}
	}

	/// Nothing to show: a quiet inbox, no results, all caught up, or a filter with nothing in it.
	@ViewBuilder
	private var emptyState: some View {
		if !search.isEmpty {
			EmptyState(symbol: "magnifyingglass", title: "No results for “\(search)”")
		} else if store.scope == .archived {
			EmptyState(symbol: "archivebox", title: "Nothing archived")
		} else if store.chip == .unread {
			EmptyState(symbol: "checkmark.circle", title: "You're all caught up") {
				Button("Show all") { store.chip = .all }.buttonStyle(.primaryAction)
			}
		} else if store.chip != .all {
			EmptyState(symbol: "bubble.left.and.bubble.right", title: "No \(store.chip.title.lowercased()) here yet") {
				Button("Show all") { store.chip = .all }.buttonStyle(.primaryAction)
			}
		} else {
			EmptyState(
				symbol: "bubble.left.and.bubble.right", title: "Nothing here yet",
				message: "Start a chat with a teammate or an agent."
			) {
				Button("New conversation", action: onNewChat).buttonStyle(.primaryAction)
			}
		}
	}

	// MARK: - Layouts

	private func pinnedTiles(_ pinned: [ConversationSummary], selection: Binding<String?>) -> some View {
		Group {
			if !pinned.isEmpty {
				PinnedTiles(
					conversations: PinnedOrder.apply(savedPinnedOrder, to: pinned), currentActorID: currentActorID, selection: selection,
					picking: picking.isActive ? picking : nil,
					onUnpin: { id in Task { await store.setPinned(id, false) } },
					onSwap: { moved, target in
						let current = PinnedOrder.apply(savedPinnedOrder, to: pinned).map(\.id)
						savedPinnedOrder = PinnedOrder.swap(current, moving: moved, onto: target)
						pinnedOrder?.save(savedPinnedOrder)
						MaskinHaptics.play(.selection)
					}
				)
				.listRowInsets(EdgeInsets(top: 0, leading: MaskinSpace.s9, bottom: MaskinSpace.s4, trailing: MaskinSpace.s9))
				.listRowBackground(Color.clear)
				.listRowSeparator(.hidden)
			}
		}
	}

	/// "One list": every conversation on its own row, in day groups.
	@ViewBuilder
	private func flatGroups(_ groups: [ConversationGroup], showCounts: Bool = false) -> some View {
		ForEach(groups) { group in
			Section {
				ForEach(group.items) { conversation in
					HStack(spacing: MaskinSpace.s5) {
						if picking.isActive {
							SelectionCheckbox(isPicked: picking.contains(conversation.id))
								.transition(.move(edge: .leading).combined(with: .opacity))
						}
						ConversationRow(
							conversation: conversation, currentActorID: currentActorID,
							draft: ChatDraftStore.text(for: conversation.id))
					}
					.selectionRowAccessibility(
						isActive: picking.isActive, isPicked: picking.contains(conversation.id))
					.tag(conversation.id)
					.rowChrome()
					.rowActions(for: conversation, store: store, enabled: !picking.isActive, onMore: { moreFor = $0 })
					.contextMenu { if !picking.isActive { menu(for: conversation) } }
					.onAppear { loadMoreIfLast(conversation.id) }
				}
			} header: {
				MonoLabel(group.label)
			}
		}
	}

	/// The person view: pinned tiles, UNREAD, PEOPLE & AGENTS.
	@ViewBuilder
	private func teamContent(_ team: TeamSections, groups: [ConversationGroup], selection: Binding<String?>) -> some View {
		pinnedTiles(team.pinned, selection: selection)
		if !team.unread.isEmpty {
			Section {
				personRows(team.unread, section: "unread")
			} header: {
				TeamSectionHeader(label: "Unread", count: team.unread.count, countColor: MaskinColor.sig) {
					Button("Mark all read") {
						MaskinHaptics.play(.selection)
						Task { await store.markRead(team.unreadConversationIDs) }
					}
					.buttonStyle(.maskinPressed)
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		if store.groupBy == .person {
			if !team.people.isEmpty {
				Section {
					personRows(team.people, section: "people")
				} header: {
					TeamSectionHeader(label: "People", count: team.people.count)
				}
			}
		} else {
			flatGroups(groups, showCounts: true)
		}
	}

	@ViewBuilder
	private func personRows(_ people: [TeamPerson], section: String) -> some View {
		ForEach(people) { person in
			let key = "\(section)-\(person.id)"
			let isOpen = expanded.contains(key)
			if person.hasSeveral {
				// Tapping the row opens the latest conversation; the chevron (44 x 36) expands the rest.
				HStack(spacing: MaskinSpace.s1) {
					ConversationRow(
						conversation: person.rowSummary, currentActorID: currentActorID,
						draft: ChatDraftStore.text(for: person.latest.id))
					Button {
						MaskinHaptics.play(.selection)
						withAnimation(.snappy) {
							if isOpen { expanded.remove(key) } else { expanded.insert(key) }
						}
					} label: {
						Image(systemName: "chevron.right")
							.font(.footnote.weight(.semibold))
							.foregroundStyle(MaskinColor.ink5)
							.rotationEffect(.degrees(isOpen ? 90 : 0))
							.frame(width: MaskinSpace.touchMin, height: MaskinSpace.s14 + MaskinSpace.s2)
							.contentShape(Rectangle())
					}
					.buttonStyle(.borderless)
					.accessibilityLabel(isOpen ? "Collapse conversations" : "Show \(person.conversations.count) conversations")
				}
				.tag(person.latest.id)
				.rowChrome()
				.rowActions(archiving: person.conversations.map(\.id), store: store)
				.onAppear { loadMoreIfLast(person.conversations.map(\.id)) }
				if isOpen {
					ForEach(person.conversations) { conversation in
						TeamConversationRow(conversation: conversation)
							.tag(conversation.id)
							.rowChrome()
							.rowActions(for: conversation, store: store, enabled: true, onMore: { moreFor = $0 })
							.contextMenu { menu(for: conversation) }
					}
					Button(action: onNewChat) {
						Label("New conversation", systemImage: "plus")
							.maskinText(.subhead).fontWeight(.semibold)
							.foregroundStyle(MaskinColor.ink3)
							.padding(.leading, ConversationRow.avatarSize + MaskinSpace.s7)
							.frame(maxWidth: .infinity, alignment: .leading)
							.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
					.rowChrome()
				}
			} else {
				ConversationRow(
					conversation: person.rowSummary, currentActorID: currentActorID,
					draft: ChatDraftStore.text(for: person.latest.id))
					.tag(person.latest.id)
					.rowChrome()
					.rowActions(for: person.latest, store: store, enabled: true, onMore: { moreFor = $0 })
					.contextMenu { menu(for: person.latest) }
					.onAppear { loadMoreIfLast(person.latest.id) }
			}
		}
	}

	private func loadMoreIfLast(_ id: String) { loadMoreIfLast([id]) }

	private func loadMoreIfLast(_ ids: [String]) {
		if let last = store.conversations.last?.id, ids.contains(last) { Task { await store.loadMore() } }
	}

	/// Bulk actions in the selection bar. Archive is the primary; the rest sit in a text menu.
	@ViewBuilder
	private func bulkActions(allIDs: [String]) -> some View {
		let ids = picking.ordered(in: allIDs)
		Menu {
			if store.scope == .active {
				Button("Pin", systemImage: "pin") { run(ids) { await store.setPinned($0, true) } }
				Button("Unpin", systemImage: "pin.slash") { run(ids) { await store.setPinned($0, false) } }
				Button("Mark as unread", systemImage: "envelope.badge") { run(ids) { await store.markUnread($0) } }
			}
		}
		label: {
			SelectionBarLabel(title: "More")
		}
		.disabled(picking.isEmpty || store.scope != .active)
		Button {
			let archiving = store.scope != .archived
			run(ids) { picked in
				let result = await store.setArchived(picked, archiving)
				if result.succeeded > 0 {
					undoOffer = UndoOffer(
						message: "\(archiving ? "Archived" : "Unarchived") \(result.succeeded). Undo."
					) { _ = await store.setArchived(picked, !archiving) }
				}
				return result
			}
		} label: {
			SelectionBarLabel(title: store.scope == .archived ? "Unarchive" : "Archive", isPrimary: true)
		}
		.buttonStyle(.maskinPressed(.shrink))
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
		if conversation.isUnread {
			Button("Mark as read", systemImage: "envelope.open") {
				Task { await store.markRead(conversation.id) }
			}
		} else {
			Button("Mark as unread", systemImage: "envelope.badge") {
				Task { await store.markUnread(conversation.id) }
			}
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
	/// A tile dropped on another: they trade places (the order is kept per user).
	var onSwap: ((_ moved: String, _ target: String) -> Void)?

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
				.buttonStyle(.maskinPressed(.shrink))
				.contextMenu {
					if picking == nil {
						Button("Unpin", systemImage: "pin.slash") { onUnpin(conversation.id) }
					}
				}
				.draggable(conversation.id)
				.dropDestination(for: String.self) { moved, _ in
					guard let moved = moved.first, let onSwap else { return false }
					onSwap(moved, conversation.id)
					return true
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

	/// 44pt: the tile's avatar.
	static let avatarSize: CGFloat = MaskinSpace.s14 + MaskinSpace.s7
}


/// The Team Display menu in the shell's pill: one row per person or one list. The choice is remembered.
struct ChatsDisplayMenu: View {
	static let groupByKey = "chats.groupBy"
	let store: ConversationsStore
	/// Whether the All · Unread · People · Agents · Groups chips show above the list (off by default).
	static let chipsKey = "chats.showFilterChips"
	@AppStorage(Self.groupByKey) private var storedGroupBy = ConversationGroupBy.time.rawValue
	@AppStorage(Self.chipsKey) private var showsChips = false

	var body: some View {
		Toggle(isOn: $showsChips) { Label("Filter chips", systemImage: "line.3.horizontal.decrease") }
		Picker(
			"Conversations",
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

extension View {
	/// The list row look every Team row shares: card fill, hairline, 12 x 16 padding.
	fileprivate func rowChrome() -> some View {
		listRowBackground(MaskinSurface.card)
			.listRowSeparatorTint(MaskinSurface.separator)
			.listRowInsets(
				EdgeInsets(
					top: MaskinSpace.s7, leading: MaskinSpace.s9, bottom: MaskinSpace.s7,
					trailing: MaskinSpace.s9))
	}

	/// Swipe right toggles read / unread (past the threshold it commits); swipe left reveals Archive,
	/// More and Pin, Archive at the edge.
	fileprivate func rowActions(
		for conversation: ConversationSummary, store: ConversationsStore, enabled: Bool,
		onMore: @escaping (ConversationSummary) -> Void
	) -> some View {
		swipeActions(edge: .leading, allowsFullSwipe: true) {
			if enabled {
				Button {
					MaskinHaptics.play(.selection)
					Task {
						if conversation.isUnread { await store.markRead(conversation.id) } else { await store.markUnread(conversation.id) }
					}
				} label: {
					Label(conversation.isUnread ? "Read" : "Unread", systemImage: conversation.isUnread ? "envelope.open" : "envelope.badge")
				}
				.tint(MaskinColor.sig)
			}
		}
		.swipeActions(edge: .trailing, allowsFullSwipe: false) {
			if enabled {
				Button {
					MaskinHaptics.play(.selection)
					Task { await store.setArchived([conversation.id], !conversation.archived) }
				} label: {
					Label(conversation.archived ? "Unarchive" : "Archive", systemImage: "archivebox")
				}
				.tint(MaskinColor.ink)
				Button {
					MaskinHaptics.play(.selection)
					onMore(conversation)
				} label: {
					Label("More", systemImage: "ellipsis")
				}
				.tint(MaskinColor.ruleStrong)
				Button {
					MaskinHaptics.play(.selection)
					Task { await store.setPinned(conversation.id, !conversation.pinned) }
				} label: {
					Label(conversation.pinned ? "Unpin" : "Pin", systemImage: conversation.pinned ? "pin.slash" : "pin")
				}
				.tint(MaskinColor.ink4)
			}
		}
	}

	/// Swipe left archives (or unarchives) these conversations.
	fileprivate func rowActions(
		archiving ids: [String], archived: Bool = false, store: ConversationsStore
	) -> some View {
		swipeActions(edge: .trailing, allowsFullSwipe: true) {
			if !ids.isEmpty {
				Button {
					MaskinHaptics.play(.selection)
					Task { await store.setArchived(ids, !archived) }
				} label: {
					Label(archived ? "Unarchive" : "Archive", systemImage: "archivebox")
				}
				.tint(MaskinColor.ink3)
			}
		}
	}
}

/// A section header in the Team list: a mono label, its count and an optional action.
struct TeamSectionHeader<Trailing: View>: View {
	let label: String
	let count: Int
	var countColor: Color = MaskinColor.inkPlaceholder
	@ViewBuilder var trailing: Trailing

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			MonoLabel(label, color: MaskinColor.ink5, size: .section)
			MonoLabel("\(count)", color: countColor, size: .section)
			Spacer(minLength: 0)
			trailing
		}
		.textCase(nil)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}
}

extension TeamSectionHeader where Trailing == EmptyView {
	init(label: String, count: Int, countColor: Color = MaskinColor.inkPlaceholder) {
		self.init(label: label, count: count, countColor: countColor) { EmptyView() }
	}
}

/// One conversation under an opened person row: its title over the newest line, the time and the
/// unread count, indented under the person's name.
struct TeamConversationRow: View {
	let conversation: ConversationSummary
	var now = Date()

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text(ChatPreviewText.plain(conversation.title))
					.maskinText(.body)
					.fontWeight(conversation.isUnread ? .bold : .semibold)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
				if let snippet = conversation.snippet.map(ChatPreviewText.plain), !snippet.isEmpty {
					Text(snippet).maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(1)
				}
			}
			Spacer(minLength: MaskinSpace.s3)
			VStack(alignment: .trailing, spacing: MaskinSpace.s2) {
				if let date = conversation.activityDate {
					Text(ChatListTime.label(for: date, now: now))
						.maskinText(.caption).foregroundStyle(MaskinColor.inkPlaceholder)
				}
				if conversation.isUnread { UnreadBadge(count: conversation.unreadCount) }
			}
		}
		.padding(.leading, ConversationRow.avatarSize + MaskinSpace.s7)
		.contentShape(Rectangle())
		.maskinHover()
		.accessibilityElement(children: .combine)
	}
}

/// The filter chips above the Team list: All · Unread n · People · Agents · Groups. 34pt pills,
/// filled `inverse` when selected.
struct ConversationChipRow: View {
	@Binding var selected: ConversationChip
	let unread: Int

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) {
				ForEach(ConversationChip.allCases) { chip in
					let on = chip == selected
					Button {
						MaskinHaptics.play(.selection)
						selected = chip
					} label: {
						Text(chip == .unread && unread > 0 ? "Unread \(unread)" : chip.title)
							.maskinText(.subhead).fontWeight(.semibold)
							.foregroundStyle(on ? MaskinSurface.onInverse : MaskinColor.ink2)
							.padding(.horizontal, MaskinSpace.s8)
							.frame(minHeight: MaskinSpace.s14 + MaskinSpace.s1)
							.background(on ? MaskinSurface.inverse : MaskinSurface.fill, in: Capsule())
							.contentShape(Capsule())
					}
					.buttonStyle(.maskinPressed(.shrink))
					.accessibilityAddTraits(on ? .isSelected : [])
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
		}
	}
}
