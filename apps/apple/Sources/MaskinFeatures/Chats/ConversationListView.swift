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
	/// Where the filter chips sit; the bottom placements draw them outside this list.
	var pillPlacement: TeamPillPlacement = .top
	/// The shell's bottom pill, told how many are unread and when row selection is running.
	var pill: TeamPillModel?

	@State private var picking = SelectionModel()
	@State private var undoOffer: UndoOffer?
	@State private var expandedPeople: Set<String> = []
	@State private var expandedSections: Set<String> = []
	@State private var archivedExpanded = false
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
				}
			})
		List(selection: rowSelection) {
			if !isLive {
				OfflineBanner(message: "Live updates paused. Reconnecting…").plainRow()
			}
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
					PinnedTiles(
						tiles: layout.tiles, currentActorID: currentActorID, workingAgentIDs: store.workingAgentIDs,
						picking: picking.isActive ? picking : nil,
						onOpen: { tile in
							if picking.isActive {
								if case .conversation(let c) = tile.kind { picking.toggle(c.id) }
							} else {
								open(tile: tile)
							}
						},
						onMove: { id, before in store.movePin(id, before: before, tiles: layout.tiles.map(\.id)) }
					) { tile in
						TeamRowMenuItems(actions: actions(for: tile))
					}
					.plainRow(insets: EdgeInsets(top: 0, leading: MaskinSpace.s9, bottom: MaskinSpace.s4, trailing: MaskinSpace.s9))
				} header: {
					TeamSectionHeader(label: "Pinned", count: nil)
				}
			}
			ForEach(layout.sections) { section in
				Section {
					ForEach(section.rows) { row in
						rowView(row, now: now)
					}
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
				} header: {
					TeamSectionHeader(
						label: section.label, count: section.count,
						countColor: section.kind == .unread ? MaskinColor.sig : MaskinColor.inkPlaceholder
					) {
						if section.showsMarkAllRead, !picking.isActive {
							Button("Mark all read") {
								MaskinHaptics.play(.selection)
								Task { await store.markRead(section.unreadConversationIDs) }
							}
							.buttonStyle(.maskinPressed)
							.maskinText(.subhead).fontWeight(.semibold)
							.foregroundStyle(MaskinColor.ink4)
						}
					}
				}
			}
			if let empty = layout.empty, store.phase == .loaded {
				TeamEmptyState(empty: empty, onSuggestion: onSuggestion) { act(on: empty, query: search) }.plainRow()
			}
			if layout.showsArchived, !picking.isActive {
				ArchivedRow(
					items: layout.isFiltering ? layout.archivedMatches : store.archivedConversations,
					currentActorID: currentActorID, expanded: $archivedExpanded, forceExpanded: layout.isFiltering,
					onUnarchive: { item in
						Task {
							if await store.setArchived(item.id, false) {
								undoOffer = UndoOffer(message: "Unarchived. Undo.") { _ = await store.setArchived(item.id, true) }
							}
						}
					},
					onOpen: { item in selection = item.id })
				.plainRow(insets: EdgeInsets(top: MaskinSpace.s3, leading: MaskinSpace.s9, bottom: MaskinSpace.s3, trailing: MaskinSpace.s9))
			}
		}
		#if os(iOS)
		.listStyle(.insetGrouped)
		.listSectionSpacing(MaskinSpace.s11 + MaskinSpace.s1)
		#else
		.listStyle(.inset)
		#endif
		.scrollContentBackground(.hidden)
		.ambientBackground()
		.teamSearch(text: $search)
		// A search looks through every archived chat, so the pages past the first are fetched.
		.task(id: !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
			if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { await store.loadMoreArchived() }
		}
		.overlay { overlay }
		.refreshable { await store.refresh() }
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
			Text("It disappears from Team. This can't be undone.")
		}
	}

	// MARK: Rows

	@ViewBuilder
	private func rowView(_ row: TeamLayout.Row, now: Date) -> some View {
		let rowActions = actions(for: row)
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
		.onAppear { loadMoreIfLast(row) }
		switch row.kind {
		case .conversation(let c):
			base.tag(c.id)
		case .person(let p):
			// Tapping a person opens their latest conversation; the chevron expands the rest.
			base.tag(p.latest.id)
			if isOpen {
				ForEach(p.conversations) { conversation in
					TeamConversationRow(conversation: conversation, now: now, draft: draft(conversation.id))
						.tag(conversation.id)
						.rowChrome()
						.teamRowActions(actions(for: conversation), enabled: !picking.isActive)
				}
				Button { onNewChat(p.participants.first) } label: {
					Label("New conversation", systemImage: "plus")
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(MaskinColor.sigInk)
						.padding(.leading, ConversationRow.clusterWidth + MaskinSpace.s7)
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

	private func selectionID(of row: TeamLayout.Row) -> String? {
		switch row.kind {
		case .conversation(let c): c.id
		case .person(let p): p.latest.id
		case .flow: nil
		}
	}

	private func status(for row: TeamLayout.Row) -> ConversationRowStatus {
		switch row.kind {
		case .conversation(let c):
			return store.status(for: c, draft: draft(c.id), tick: sendTick(c))
		case .person(let p):
			if p.hasSeveral {
				var status = store.status(for: p.latest)
				status.preview = "\(p.conversations.count) conversations · \(ChatPreviewText.plain(p.latest.title))"
				return status
			}
			return store.status(for: p.latest, draft: draft(p.latest.id), tick: sendTick(p.latest))
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

	private func actions(for tile: TeamLayout.Tile) -> TeamRowActions {
		switch tile.kind {
		case .conversation(let c): actions(for: c)
		case .flow(let f): actions(for: f)
		}
	}

	private func actions(for c: ConversationSummary) -> TeamRowActions {
		TeamRowActions(
			isPinned: c.pinned, isUnread: c.isUnread,
			pin: { Task { await store.setPinned(c.id, !c.pinned) } },
			toggleRead: { Task { if c.isUnread { await store.markRead([c.id]) } else { await store.markUnread(c.id) } } },
			archive: { archive([c.id]) },
			delete: { deleteTarget = DeleteTarget(id: c.id, title: TeamLayout.title(of: c, me: currentActorID), conversationIDs: [c.id]) },
			more: { menuTarget = TeamRowMenuTarget(id: c.id, title: TeamLayout.title(of: c, me: currentActorID), actions: actions(for: c)) },
			select: { picking.enter(selecting: c.id) })
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

	private func open(tile: TeamLayout.Tile) {
		switch tile.kind {
		case .conversation(let c): selection = c.id
		case .flow(let f): selection = f.pinKey
		}
	}

	private func act(on empty: TeamLayout.Empty, query: String) {
		switch empty {
		case .nothing: onNewChat(nil)
		case .noResults: onSearchEverywhere(query.trimmingCharacters(in: .whitespacesAndNewlines))
		case .caughtUp, .noKind: store.chip = .all
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
				symbol: "wifi.exclamationmark", title: "Couldn't load Team", message: Self.failureMessage(reason)) {
				Button("Try again") { Task { await store.refresh() } }.buttonStyle(.secondaryAction)
			}
		case .loaded:
			EmptyView()
		}
	}
}

/// The Team Display menu in the shell's pill (spec 7 §6): LAYOUT (Sections / One list),
/// CONVERSATIONS grouping (only in Sections) and FILTER CHIPS (Show / Hide). The store persists
/// the choice per user.
struct ChatsDisplayMenu: View {
	@Bindable var store: ConversationsStore

	var body: some View {
		Picker("Show as", selection: $store.displayOptions.layout) {
			ForEach(TeamDisplayOptions.Layout.allCases, id: \.self) { Text($0.label).tag($0) }
		}
		.pickerStyle(.inline)
		if store.displayOptions.layout == .sections {
			Picker("Group by", selection: $store.displayOptions.grouping) {
				ForEach(TeamDisplayOptions.Grouping.allCases, id: \.self) { Text($0.label).tag($0) }
			}
			.pickerStyle(.inline)
		}
		Picker("Quick filters", selection: $store.displayOptions.showsFilterChips) {
			Text("Show").tag(true)
			Text("Hide").tag(false)
		}
		.pickerStyle(.inline)
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

	/// A list row that is its own card (tiles, chips, the Archived row, an empty state).
	fileprivate func plainRow(insets: EdgeInsets = EdgeInsets()) -> some View {
		listRowInsets(insets)
			.listRowBackground(Color.clear)
			.listRowSeparator(.hidden)
	}
}

/// A section header in the Team list: a mono label, its count and an optional action.
struct TeamSectionHeader<Trailing: View>: View {
	let label: String
	let count: Int?
	var countColor: Color = MaskinColor.inkPlaceholder
	@ViewBuilder var trailing: Trailing

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			MonoLabel(label, color: MaskinColor.ink5, size: .section)
			if let count { MonoLabel("\(count)", color: countColor, size: .section) }
			Spacer(minLength: 0)
			trailing
		}
		.textCase(nil)
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
		.padding(.leading, ConversationRow.clusterWidth + MaskinSpace.s7)
		.contentShape(Rectangle())
		.maskinHover()
		.accessibilityElement(children: .combine)
	}

	private var preview: Text {
		if let draft, !draft.isEmpty { return Text(verbatim: "Draft: \(draft)") }
		let pieces = conversation.snippet.map(ChatPreviewText.linePieces) ?? []
		guard !pieces.isEmpty else { return Text(ConversationRowStatus.noMessages) }
		let lead = conversation.snippetActorName.flatMap { who in who.isEmpty ? nil : "\(who): " }
		return ChatPreviewLine.text("", pieces: (lead.map { [ChatPreviewText.Piece($0)] } ?? []) + pieces)
	}
}
