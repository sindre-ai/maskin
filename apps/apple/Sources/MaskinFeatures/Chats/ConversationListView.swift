import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Team list (spec 7 §6): pinned tiles, then UNREAD · FLOWS · PEOPLE (or time groups, or one
/// ALL card), each row with swipe actions and a long-press menu, the Archived row at the bottom,
/// and the empty states. Search and the filter chips narrow every section live. Selection mode
/// (Select in the row menu) turns rows into checkboxes with bulk actions in the bar. The list is
/// the sidebar column on iPad and Mac, the whole tab on iPhone.
struct ConversationListView: View {
	@Bindable var store: ConversationsStore
	@Binding var selection: String?
	@Binding var search: String
	let currentActorID: String?
	var isLive = true
	/// A fixed clock for snapshots; the wall clock otherwise.
	var now: Date?
	/// The state of your latest message in a conversation, from the send queue.
	var sendTick: @MainActor (ConversationSummary) -> ConversationRowStatus.Tick? = { _ in nil }
	/// Unsent text per conversation, for "Draft: …".
	var draft: @MainActor (String) -> String? = { ChatDraftStore.draft(for: $0) }
	/// New conversation, optionally with someone already in the To field.
	let onNewChat: (ChatParticipant?) -> Void
	var onSearchEverywhere: (String) -> Void = { _ in }
	/// A suggested first message from the empty state, sent to the Chief of Staff.
	var onSuggestion: (String) -> Void = { _ in }
	/// Opens the Threads screen; nil hides its chip (previews and snapshots).
	var onThreads: (() -> Void)?
	/// The list search's server side. Nil keeps the on-screen filter (previews and snapshots).
	var chatSearch: ChatListSearchModel?
	/// Where the filter chips sit; the bottom placements draw them outside this list.
	var pillPlacement: TeamPillPlacement = .top
	/// The shell's bottom pill, told how many are unread and when row selection is running.
	var pill: TeamPillModel?

	@State private var picking = SelectionModel()
	@State private var undoOffer: UndoOffer?
	@State private var expandedPeople: Set<String> = []
	@State private var expandedSections: Set<String> = []
	@State private var menuTarget: TeamRowMenuTarget?
	@State private var deleteTarget: DeleteTarget?

	private struct DeleteTarget: Identifiable {
		var id: String
		var title: String
		var conversationIDs: [String]
	}

	var body: some View {
		let now = now ?? Date()
		let layout = store.layout(
			query: search, currentActorID: currentActorID, expandedSectionIDs: expandedSections, now: now)
		let allIDs = layout.conversationIDs
		// While selecting, a tap toggles the row instead of opening it.
		let rowSelection = Binding<String?>(
			get: { picking.isActive ? nil : selection },
			set: { id in
				if picking.isActive {
					if let id, !id.hasPrefix(TeamLayout.flowPinKey("")) { picking.toggle(id) }
				} else {
					selection = id
					trackOpened(id, layout: layout)
				}
			})
		List(selection: rowSelection) {
			if !isLive {
				OfflineBanner(message: "Live updates paused. Reconnecting…").plainRow()
			}
			if let serverSearch, isSearching {
				searchResults(serverSearch)
			} else if store.showsArchivedList {
				archivedSection
			} else {
				activeContent(layout: layout, now: now)
			}
		}
		#if os(iOS)
		// v3: edge-to-edge rows with hairlines on the page, not cards in an inset group.
		.listStyle(.plain)
		#else
		.listStyle(.inset)
		#endif
		.scrollContentBackground(.hidden)
		// 16 pt of air between the title and the first group.
		.contentMargins(.top, MaskinSpace.s9, for: .scrollContent)
		// Groups sit close: the plain list's header minimum and section gap are what made them drift apart.
		.environment(\.defaultMinListHeaderHeight, MaskinSpace.s1)
		#if os(iOS)
		.listSectionSpacing(.compact)
		#endif
		.ambientBackground()
		// v3 has no search field on Chats: Search is its own tab. `teamSearch` stays for callers that want it.
		// A search looks through every archived chat, so the pages past the first are fetched.
		.task(id: !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
			if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { await store.loadMoreArchived() }
		}
		// Words in the search go to the server, which looks through every chat: titles, people and
		// message text, archived ones included. The answer replaces the list while words are typed.
		.task(id: search) { await chatSearch?.update(search) }
		// One event per search that has settled, with how many chats it found: the server's hits
		// when they replace the list, else the chats the on-screen filter shows.
		.task(id: "\(search.trimmingCharacters(in: .whitespacesAndNewlines))|\(serverSearch?.phase == .loaded)") {
			let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
			guard !query.isEmpty, (try? await Task.sleep(for: .seconds(1))) != nil else { return }
			if let serverSearch {
				guard serverSearch.phase == .loaded else { return }
				Analytics.shared.chatListSearchUsed(resultCount: serverSearch.hits.count)
				return
			}
			// Read again after the wait, so pages that arrived meanwhile are counted.
			let settled = store.layout(
				query: query, currentActorID: currentActorID, expandedSectionIDs: expandedSections, now: Date())
			Analytics.shared.chatListSearchUsed(resultCount: settled.shownChatCount)
		}
		.task(id: store.showsArchivedList) {
			if store.showsArchivedList {
				await store.refreshArchived()
				await store.loadMoreArchived()
			}
		}
		.overlay { overlay }
		.animation(.snappy, value: picking.isActive)
		.onChange(of: allIDs) { picking.prune(toVisible: allIDs) }
		.selectionToolbar(picking, allIDs: allIDs, noun: "chat") { bulkActions(allIDs: allIDs) }
		.undoToast($undoOffer)
		.safeAreaInset(edge: .bottom, spacing: MaskinSpace.s4) {
			if pillPlacement == .floating, store.displayOptions.showsFilterChips, !picking.isActive {
				TeamFloatingPill(
					chip: $store.chip, unreadCount: layout.unreadCount,
					threadsUnread: store.threadSections.unreadCount, onThreads: onThreads)
			}
		}
		.onChange(of: layout.unreadCount, initial: true) { _, count in pill?.unreadCount = count }
		.onChange(of: picking.isActive, initial: true) { _, active in pill?.isSelecting = active }
		.teamRowMenu($menuTarget)
		.confirmationDialog(
			deleteTarget.map { $0.conversationIDs.count > 1 ? "Delete \($0.conversationIDs.count) conversations with \($0.title)?" : "Delete this conversation?" } ?? "",
			isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }),
			titleVisibility: .visible, presenting: deleteTarget
		) { target in
			Button("Delete", role: .destructive) {
				MaskinHaptics.play(.warning)
				Task { for id in target.conversationIDs { await store.delete(id) } }
			}
		} message: { _ in
			Text("It disappears from your chats. This can't be undone.")
		}
	}

	// MARK: Search

	private var isSearching: Bool { !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

	/// The list search model when it can ask the server; nil keeps the on-screen filter.
	private var serverSearch: ChatListSearchModel? { chatSearch.flatMap { $0.isAvailable ? $0 : nil } }

	/// The server's hits for the typed words. A hit the default list leaves out (archived, or quiet
	/// for a long while) is marked Archived; tapping any hit opens it, loaded or not.
	@ViewBuilder
	private func searchResults(_ model: ChatListSearchModel) -> some View {
		let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
		let loaded = Dictionary(store.conversations.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
		let oldest = store.conversations.compactMap { $0.lastMessageAt ?? $0.createdAt }.min()
		let hasMore = store.hasMore || store.phase != .loaded
		if model.phase == .failed, model.hits.isEmpty {
			Text("Couldn't search chats. Check your connection and try again.")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				.plainRow(insets: EdgeInsets(top: MaskinSpace.s9, leading: MaskinSpace.s9, bottom: MaskinSpace.s4, trailing: MaskinSpace.s9))
		} else if model.phase == .loaded, model.hits.isEmpty {
			EmptyState(
				symbol: "magnifyingglass", title: "No chats found",
				message: "No chat has that in its title, its people or its messages.")
				.plainRow()
		} else {
			Section {
				ForEach(model.hits) { hit in
					ChatSearchRow(
						hit: hit, query: query,
						participants: loaded[hit.id].map { $0.others(excluding: currentActorID) } ?? [],
						isArchived: ChatSearchRules.isArchived(
							hit, loadedIDs: Set(loaded.keys), hasMore: hasMore, oldestActivity: oldest))
						.tag(hit.id)
						.rowChrome()
				}
			}
			.opacity(model.phase == .loading ? 0.6 : 1)
		}
	}

	// MARK: Rows

	@ViewBuilder
	private func rowView(_ row: TeamLayout.Row, now: Date, pinned: [String]? = nil) -> some View {
		let rowActions = pinned.map { actions(for: row, among: $0) } ?? actions(for: row)
		let isOpen = expandedPeople.contains(row.id)
		let base = HStack(spacing: MaskinSpace.s5) {
			if picking.isActive, let id = selectionID(of: row) {
				SelectionCheckbox(isPicked: picking.contains(id))
					.transition(.move(edge: .leading).combined(with: .opacity))
			}
			TeamRow(
				row: row, status: status(for: row), currentActorID: currentActorID, now: now,
				workingAgentIDs: store.workingAgentIDs, expanded: isOpen,
				onToggleExpanded: {
					withAnimation(MaskinMotion.standard) {
						if isOpen { expandedPeople.remove(row.id) } else { expandedPeople.insert(row.id) }
					}
				})
		}
		.selectionRowAccessibility(isActive: picking.isActive, isPicked: selectionID(of: row).map(picking.contains) ?? false)
		.rowChrome()
		.teamRowActions(rowActions, enabled: !picking.isActive)
		.pinReorder(id: row.id, enabled: pinned != nil && !picking.isActive) { dragged, target in
			store.movePin(dragged, before: target, tiles: pinned ?? [])
		}
		.onAppear { loadMoreIfLast(row) }
		switch row.kind {
		case .conversation(let c):
			base.tag(c.id)
		case .person(let p):
			// Tapping a person opens their latest conversation; the chevron expands the rest.
			base.tag(p.latest.id)
			if isOpen {
				ForEach(p.conversations) { conversation in
					TeamConversationRow(
						conversation: conversation, currentActorID: currentActorID, now: now, draft: draft(conversation.id))
						.tag(conversation.id)
						.rowChrome()
						.teamRowActions(actions(for: conversation), enabled: !picking.isActive)
				}
				Button { onNewChat(p.participants.first) } label: {
					Label("New conversation", systemImage: "plus")
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.sigInk)
						.padding(.leading, ConversationRow.clusterWidth + MaskinSpace.s8)
						.frame(maxWidth: .infinity, alignment: .leading)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.rowChrome()
			}
		case .flow(let f):
			// Selecting a flow row shows the flow in the detail column (`flow:<id>`).
			base.tag(f.pinKey)
		}
	}

	/// A person's tap opened a chat from the list. Flow rows are not chats and send nothing.
	private func trackOpened(_ id: String?, layout: TeamLayout) {
		guard let id, !id.hasPrefix(TeamLayout.flowPinKey("")) else { return }
		let searching = isSearching
		// A hit of the server search sits among the hits, not in the grouped list.
		let place =
			searching && serverSearch != nil
			? ChatListTracking.searchPlace(of: id, among: serverSearch?.hits ?? [])
			: layout.chatListPlace(of: id, searching: searching)
		guard let place else { return }
		Analytics.shared.chatOpenedFromList(place)
	}

	private func selectionID(of row: TeamLayout.Row) -> String? {
		switch row.kind {
		case .conversation(let c): c.id
		case .person(let p): p.latest.id
		case .flow: nil
		}
	}

	private func status(for row: TeamLayout.Row) -> ConversationRowStatus {
		rawStatus(for: row).applying(store.displayOptions)
	}

	private func rawStatus(for row: TeamLayout.Row) -> ConversationRowStatus {
		switch row.kind {
		case .conversation(let c):
			return store.status(
				for: c, draft: draft(c.id), tick: sendTick(c),
				displayedTitle: TeamLayout.displayedTitle(of: row.kind, me: currentActorID), me: currentActorID)
		case .person(let p):
			if p.hasSeveral {
				var status = store.status(
					for: p.latest, displayedTitle: TeamLayout.displayedTitle(of: row.kind, me: currentActorID),
					me: currentActorID)
				status.preview = "\(p.conversations.count) conversations · \(ChatPreviewText.plain(p.latest.title))"
				return status
			}
			return store.status(
				for: p.latest, draft: draft(p.latest.id), tick: sendTick(p.latest),
				displayedTitle: TeamLayout.displayedTitle(of: row.kind, me: currentActorID), me: currentActorID)
		case .flow(let f):
			return ConversationRowStatus.make(flow: f)
		}
	}

	private func loadMoreIfLast(_ row: TeamLayout.Row) {
		let ids: [String]
		switch row.kind {
		case .conversation(let c): ids = [c.id]
		case .person(let p): ids = p.conversations.map(\.id)
		case .flow: return
		}
		if let last = store.conversations.last?.id, ids.contains(last) { Task { await store.loadMore() } }
	}

	// MARK: Actions

	private func actions(for row: TeamLayout.Row) -> TeamRowActions {
		switch row.kind {
		case .conversation(let c): actions(for: c)
		case .person(let p): actions(for: p)
		case .flow(let f): actions(for: f)
		}
	}

	/// A pinned row's actions: the ordinary ones plus Move earlier / later within the pinned order.
	private func actions(for row: TeamLayout.Row, among ids: [String]) -> TeamRowActions {
		var base = actions(for: row)
		if let i = ids.firstIndex(of: row.id) {
			if i > 0 { base.moveEarlier = { store.movePin(row.id, before: ids[i - 1], tiles: ids) } }
			if i < ids.count - 1 { base.moveLater = { store.movePin(row.id, before: ids[i + 1], tiles: ids) } }
		}
		return base
	}

	private func actions(for c: ConversationSummary) -> TeamRowActions {
		TeamRowActions(
			isPinned: c.pinned, isUnread: c.isUnread,
			pin: { Task { await store.setPinned(c.id, !c.pinned) } },
			toggleRead: { Task { if c.isUnread { await store.markRead([c.id]) } else { await store.markUnread(c.id) } } },
			archive: { archive([c.id]) },
			delete: { deleteTarget = DeleteTarget(id: c.id, title: TeamLayout.title(of: c, me: currentActorID), conversationIDs: [c.id]) },
			more: { menuTarget = TeamRowMenuTarget(id: c.id, title: TeamLayout.title(of: c, me: currentActorID), actions: actions(for: c)) },
			select: { picking.enter(selecting: c.id) },
			roomActions: roomActions(for: c))
	}

	/// "Make this a room" on an ordinary chat; "Make this a flow" and "Turn back into a chat" on a
	/// room a person made. A direct message and a flow's own room have none.
	private func roomActions(for c: ConversationSummary) -> [TeamRowActions.RoomAction] {
		guard !c.isDirect else { return [] }
		if c.roomKind == nil {
			return [
				.init(title: "Make this a room", symbol: "number") { Task { await store.setRoom(c.id, true) } }
			]
		}
		guard c.roomKind == .free else { return [] }
		return [
			.init(title: "Make this a flow", symbol: "arrow.triangle.2.circlepath") {
				Task { await store.makeFlow(c.id) }
			},
			.init(title: "Turn back into a chat", symbol: "number") { Task { await store.setRoom(c.id, false) } },
		]
	}

	private func actions(for p: TeamPerson) -> TeamRowActions {
		let ids = p.conversations.map(\.id)
		let latest = p.latest
		return TeamRowActions(
			isPinned: latest.pinned, isUnread: p.isUnread,
			pin: { Task { await store.setPinned(latest.id, !latest.pinned) } },
			toggleRead: {
				Task {
					if p.isUnread { await store.markRead(ids) } else { await store.markUnread(latest.id) }
				}
			},
			archive: { archive(ids) },
			delete: { deleteTarget = DeleteTarget(id: "person:\(p.id)", title: p.name, conversationIDs: ids) },
			more: { menuTarget = TeamRowMenuTarget(id: "person:\(p.id)", title: p.name, actions: actions(for: p)) },
			select: { picking.enter(selecting: latest.id) })
	}

	private func actions(for f: TeamFlowRoom) -> TeamRowActions {
		let pinned = store.pinnedFlowIDs.contains(f.id)
		return TeamRowActions(
			isPinned: pinned, isUnread: f.unreadCount > 0, canToggleRead: false, canArchive: false, canDelete: false,
			pin: { store.setFlowPinned(f.id, !pinned) }, toggleRead: {}, archive: {}, delete: {},
			more: { menuTarget = TeamRowMenuTarget(id: f.pinKey, title: f.name, actions: actions(for: f)) })
	}

	private func archive(_ ids: [String]) {
		Task {
			let result = await store.setArchived(ids, true)
			if result.succeeded > 0 {
				undoOffer = UndoOffer(message: "Archived \(result.succeeded). Undo.") { _ = await store.setArchived(ids, false) }
			}
		}
	}

	private func act(on empty: TeamLayout.Empty, query: String) {
		switch empty {
		case .nothing: onNewChat(nil)
		case .noResults: onSearchEverywhere(query.trimmingCharacters(in: .whitespacesAndNewlines))
		case .caughtUp, .noKind:
			store.chip = .all
			store.displayOptions.unreadOnly = false
		}
	}

	/// Bulk actions in the selection bar. Archive is the primary; the rest sit in a text menu.
	@ViewBuilder
	private func bulkActions(allIDs: [String]) -> some View {
		let ids = picking.ordered(in: allIDs)
		Menu {
			Button("Pin", systemImage: "pin") { run(ids) { await store.setPinned($0, true) } }
			Button("Unpin", systemImage: "pin.slash") { run(ids) { await store.setPinned($0, false) } }
			Button("Mark as read", systemImage: "envelope.open") { run(ids) { await store.markRead($0) } }
			Button("Mark as unread", systemImage: "envelope.badge") { run(ids) { await store.markUnread($0) } }
		} label: {
			SelectionBarLabel(title: "More")
		}
		.disabled(picking.isEmpty)
		Button {
			run(ids) { picked in
				let result = await store.setArchived(picked, true)
				if result.succeeded > 0 {
					undoOffer = UndoOffer(message: "Archived \(result.succeeded). Undo.") {
						_ = await store.setArchived(picked, false)
					}
				}
				return result
			}
		} label: {
			SelectionBarLabel(title: "Archive", isPrimary: true)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(picking.isEmpty)
	}

	@ViewBuilder
	private func sectionFooter(_ section: TeamLayout.Section) -> some View {
		if let footer = section.canCollapse ? "Show fewer" : section.moreLabel {
			Button {
				withAnimation(MaskinMotion.standard) {
					if section.canCollapse { expandedSections.remove(section.id) } else { expandedSections.insert(section.id) }
				}
			} label: {
				HStack(spacing: MaskinSpace.s5) {
					Text(footer)
						.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink2)
					Spacer()
					Image(systemName: "chevron.right")
						.maskinSymbol(MaskinFontSize.t13, weight: .semibold)
						.foregroundStyle(MaskinColor.inkPlaceholder)
						.rotationEffect(.degrees(section.canCollapse ? -90 : 90))
				}
				.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s12)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.rowChrome()
		}
	}

	/// The active chats: filter chips, the Pinned rows, then the day or person sections.
	@ViewBuilder
	private func activeContent(layout: TeamLayout, now: Date) -> some View {
			if store.displayOptions.showsFilterChips, pillPlacement == .top, !picking.isActive {
				TeamFilterChips(
					chip: $store.chip, unreadCount: layout.unreadCount,
					threadsUnread: store.threadSections.unreadCount, onThreads: onThreads)
					.plainRow(insets: EdgeInsets(top: 0, leading: 0, bottom: MaskinSpace.s4, trailing: 0))
			}
			if let onThreads, !store.displayOptions.showsFilterChips, !store.threads.isEmpty, !picking.isActive {
				ThreadsEntryRow(unread: store.threadSections.unreadCount, onOpen: onThreads)
					.plainRow(insets: EdgeInsets(top: 0, leading: MaskinSpace.s9, bottom: MaskinSpace.s4, trailing: MaskinSpace.s9))
			}
			if !layout.tiles.isEmpty {
				Section {
					ForEach(layout.tiles) { tile in
						rowView(tile.row, now: now, pinned: layout.tiles.map(\.id))
					}
				} header: {
					TeamSectionHeader(label: "Pinned", count: layout.tiles.count)
				}
			}
			ForEach(layout.sections) { section in
				Section {
					ForEach(section.rows) { row in
						rowView(row, now: now)
					}
					sectionFooter(section)
				} header: {
					TeamSectionHeader(
						label: section.label, count: section.count,
						countColor: section.kind == .unread ? MaskinColor.sig : MaskinColor.inkPlaceholder)
				}
			}
			if let empty = layout.empty, store.phase == .loaded {
				TeamEmptyState(empty: empty, onSuggestion: onSuggestion) { act(on: empty, query: search) }.plainRow()
			}
	}

	/// The archive, reached from Display > Chats > Archived: a flat list, each row opens or unarchives.
	@ViewBuilder
	private var archivedSection: some View {
		Section {
			if store.archivedConversations.isEmpty {
				Text("No archived chats")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.plainRow(insets: EdgeInsets(top: MaskinSpace.s4, leading: MaskinSpace.s9, bottom: MaskinSpace.s4, trailing: MaskinSpace.s9))
			} else {
				ArchivedRow(
					items: store.archivedConversations, currentActorID: currentActorID,
					expanded: .constant(true), showsHeader: false,
					onUnarchive: { item in
						Task {
							if await store.setArchived(item.id, false) {
								undoOffer = UndoOffer(message: "Unarchived. Undo.") { _ = await store.setArchived(item.id, true) }
							}
						}
					},
					onOpen: { item in
						selection = item.id
						// The archive is a flat list, so a row's place is its place in that list.
						if let index = store.archivedConversations.firstIndex(where: { $0.id == item.id }) {
							Analytics.shared.chatOpenedFromList(
								.init(source: .list, section: .recent, position: index + 1))
						}
					})
				.plainRow(insets: EdgeInsets(top: 0, leading: MaskinSpace.s9, bottom: 0, trailing: MaskinSpace.s9))
			}
		} header: {
			TeamSectionHeader(label: "Archived", count: store.archivedConversations.count)
		}
	}

	private func run(_ ids: [String], _ action: @escaping ([String]) async -> BulkResult) {
		MaskinHaptics.play(.selection)
		picking.exit()
		Task { _ = await action(ids) }
	}

	/// Plain wording for people; debug builds add the underlying error so a bad response is findable.
	private static func failureMessage(_ reason: String) -> String {
		let plain = "Check your connection and try again."
		#if DEBUG
			return "\(plain)\n\(reason)"
		#else
			return plain
		#endif
	}

	@ViewBuilder
	private var overlay: some View {
		switch store.phase {
		case .idle, .loading:
			if store.conversations.isEmpty { LoadingSkeleton(rows: 4).padding(MaskinSpace.s9) }
		case .failed(let reason):
			EmptyState(
				symbol: "wifi.exclamationmark", title: "Couldn't load chats", message: Self.failureMessage(reason)) {
				Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			EmptyView()
		}
	}
}

/// The Chats Display sheet (handoff v15): Group by Sections or None, Show All chats or Unread, and
/// the Preview and Working line properties. The store persists the choice per user.
struct ChatsDisplaySheet: View {
	@Bindable var store: ConversationsStore

	var body: some View {
		DisplaySheet(canReset: store.displayOptions.isCustomised, onReset: { store.displayOptions = .default }) {
			DisplaySection(title: "Grouping", showsDivider: false) {
				DisplayChoice(
					label: "Group by", options: [(true, "Sections"), (false, "None")],
					selection: $store.displayOptions.isSectioned)
				if store.displayOptions.isSectioned {
					DisplayChoice(
						label: "Sections",
						options: TeamDisplayOptions.Grouping.allCases.map { ($0, $0.label) },
						selection: $store.displayOptions.grouping)
				}
			}
			DisplaySection(title: "Filters") {
				DisplayChoice(
					label: "Chats", options: [(false, "Active"), (true, "Archived")],
					selection: $store.showsArchivedList)
				DisplayChoice(
					label: "Show", options: [(false, "All chats"), (true, "Unread")],
					selection: $store.displayOptions.unreadOnly)
				DisplayChoice(
					label: "Quick filters", options: [(false, "Hide"), (true, "Show")],
					selection: $store.displayOptions.showsFilterChips)
			}
			DisplaySection(title: "Properties") {
				DisplayToggles(
					label: "Show",
					items: [
						.init(id: "preview", title: "Preview", isOn: $store.displayOptions.showsPreview),
						.init(id: "working", title: "Working line", isOn: $store.displayOptions.showsWorkingLine),
					])
			}
		}
	}
}

extension View {
	/// The list row look every Team row shares: edge to edge, hairline, 12 x 16 padding.
	fileprivate func rowChrome() -> some View {
		listRowBackground(Color.clear)
			.listRowSeparator(.hidden)
			.listRowInsets(
				EdgeInsets(
					top: MaskinSpace.s7, leading: MaskinSpace.s9, bottom: MaskinSpace.s7,
					trailing: MaskinSpace.s9))
	}

	/// A list row that is its own card (tiles, chips, the Archived row, an empty state).
	fileprivate func plainRow(insets: EdgeInsets = EdgeInsets()) -> some View {
		listRowInsets(insets)
			.listRowBackground(Color.clear)
			.listRowSeparator(.hidden)
	}
}

/// A section header in the Team list: a sentence-case label, its count and an optional action (v3).
struct TeamSectionHeader<Trailing: View>: View {
	let label: String
	let count: Int?
	var countColor: Color = MaskinColor.inkPlaceholder
	@ViewBuilder var trailing: Trailing

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			Text(label)
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink)
			if let count {
				Text("\(count)")
					.maskinText(.subhead)
					.monospacedDigit()
					.foregroundStyle(countColor)
			}
			Spacer(minLength: 0)
			trailing
		}
		.textCase(nil)
		.padding(.top, MaskinSpace.s12)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}
}

extension TeamSectionHeader where Trailing == EmptyView {
	init(label: String, count: Int?, countColor: Color = MaskinColor.inkPlaceholder) {
		self.init(label: label, count: count, countColor: countColor) { EmptyView() }
	}
}

/// One conversation under an opened person row: its title over the newest line (or the draft),
/// the time and the unread count, indented under the person's name.
struct TeamConversationRow: View {
	let conversation: ConversationSummary
	/// Who "You:" is, and which participant a preview may leave unnamed.
	var currentActorID: String?
	var now = Date()
	var draft: String?

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text(ChatPreviewText.plain(conversation.title))
					.maskinText(.body)
					.fontWeight(conversation.isUnread ? .bold : .semibold)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
				preview.maskinText(.subhead).foregroundStyle(MaskinColor.ink4).lineLimit(1)
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
		.padding(.leading, ConversationRow.clusterWidth + MaskinSpace.s8)
		.contentShape(Rectangle())
		.maskinHover()
		.accessibilityElement(children: .combine)
	}

	private var preview: Text {
		if let draft, !draft.isEmpty { return Text(verbatim: "Draft: \(draft)") }
		let pieces = conversation.snippet.map(ChatPreviewText.linePieces) ?? []
		guard !pieces.isEmpty else { return Text(ConversationRowStatus.noMessages) }
		// This row shows the conversation's own title, so that is what the author is compared with.
		let lead = conversation.snippetAuthorLead(
			displayedTitle: ChatPreviewText.plain(conversation.title), me: currentActorID)
		return ChatPreviewLine.text("", pieces: (lead.map { [ChatPreviewText.Piece($0)] } ?? []) + pieces)
	}
}
