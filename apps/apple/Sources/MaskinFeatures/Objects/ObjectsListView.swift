import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The list half of the Objects tab. Rows link by value in a stack, or drive `selection` in a
/// split view (when `selection` is non-nil).
struct ObjectsListView: View {
	@Bindable var store: ObjectsStore
	@Bindable var board: ObjectsBoardStore
	let selection: Binding<String?>?
	/// Set on iPhone, where a row pushes its detail with a zoom.
	var zoomNamespace: Namespace.ID?
	/// Owned by the screen so the Display menu's "Select" can start it.
	let picking: SelectionModel

	@Environment(\.horizontalSizeClass) private var sizeClass
	@State private var undoOffer: UndoOffer?
	@State private var search = ""
	@State private var searchPresented = false
	@State private var pendingDelete: WorkObject?
	@State private var statusTarget: WorkObject?
	@State private var goingTo = false
	@State private var holdTarget: ObjectAsk?
	@Environment(AppRuntime.self) private var appRuntime: AppRuntime?
	/// Opens an object (pushes its detail); used when an ask can't be answered by a swipe.
	var openObject: ((String) -> Void)?

	var body: some View {
		VStack(spacing: 0) {
			typePicker
			if store.isOffline && !store.objects.isEmpty {
				AmberNotice.offline(since: store.freshness.updatedAt) { Task { await store.reload() } }
					.padding(.horizontal, MaskinSpace.s9).padding(.bottom, MaskinSpace.s4)
			}
			content
		}
		.ambientBackground()
		.onChange(of: openAsks, initial: true) { _, asks in store.setAsks(asks) }
		.task { await loadAsks() }
		.sheet(isPresented: $goingTo) { ObjectsGoToSheet(store: store) }
		.sheet(item: $holdTarget) { ask in
			HoldReasonSheet(agent: ask.by) { reason in hold(ask, reason: reason) }
		}
		.animation(.snappy, value: picking.isActive)
		// Selection belongs to the list; leaving it for the board ends it.
		.onChange(of: store.display.layout) { picking.exit() }
		.onChange(of: allIDs) { picking.prune(toVisible: allIDs) }
		.selectionToolbar(picking, allIDs: allIDs, noun: "object") { bulkActions }
		.undoToast($undoOffer)
		.searchable(text: $search, isPresented: $searchPresented, prompt: "Search objects")
		.searchMinimized()
		// Closing the field collapses it back to the icon, so it can't keep a stale query.
		.onChange(of: searchPresented) { if !searchPresented { search = "" } }
		.task(id: search) {
			if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
			if !Task.isCancelled { await store.setSearch(search) }
		}
		.confirmationDialog(
			"Change status", isPresented: Binding(
				get: { statusTarget != nil }, set: { if !$0 { statusTarget = nil } }),
			titleVisibility: .visible, presenting: statusTarget
		) { object in
			ForEach(store.directory.schema.statuses(for: object.type), id: \.self) { status in
				Button(MaskinStatus.label(for: status)) {
					MaskinHaptics.play(.selection)
					Task { await store.setStatus(object.id, status) }
				}
			}
		} message: { object in
			Text(object.displayTitle)
		}
		.confirmationDialog(
			"Delete this object?", isPresented: Binding(
				get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
			titleVisibility: .visible, presenting: pendingDelete
		) { object in
			Button("Delete \(object.displayTitle)", role: .destructive) {
				Task { await store.delete(object.id) }
			}
		} message: { _ in
			Text("This can't be undone.")
		}
	}

	// MARK: Selection

	private var allIDs: [String] { store.groups.flatMap { $0.objects.map(\.id) } }

	/// Set status, Assign and Archive (primary) over the picked objects. Actions that don't apply
	/// to every picked type are disabled.
	@ViewBuilder private var bulkActions: some View {
		let ids = picking.ordered(in: allIDs)
		let statuses = store.commonStatuses(for: ids)
		Menu {
			ForEach(statuses, id: \.self) { status in
				Button(MaskinStatus.label(for: status)) {
					runRecording(ids, verb: "Moved") { await store.setStatusRecording(ids, to: status) }
				}
			}
		} label: {
			SelectionBarLabel(title: "Set status")
		}
		.disabled(picking.isEmpty || statuses.isEmpty)
		Menu {
			ForEach(assignees) { actor in
				Button(actor.name) {
					MaskinHaptics.play(.selection)
					picking.exit()
					Task { await store.assign(ids, to: actor.id) }
				}
			}
		} label: {
			SelectionBarLabel(title: "Assign")
		}
		.disabled(picking.isEmpty || assignees.isEmpty)
		Button {
			runRecording(ids, verb: "Archived") { await store.archive(ids) }
		} label: {
			SelectionBarLabel(title: "Archive", isPrimary: true)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(picking.isEmpty || !store.canArchive(ids))
	}

	/// People first, then agents, each by name.
	private var assignees: [ActorRef] {
		store.directory.actors.values.sorted {
			$0.isAgent != $1.isAgent ? !$0.isAgent : $0.name.localizedStandardCompare($1.name) == .orderedAscending
		}
	}

	/// Runs a status-changing bulk action and offers "Archived {n}. Undo." (or "Moved {n}. Undo.").
	private func runRecording(
		_ ids: [String], verb: String,
		_ action: @escaping () async -> (result: BulkResult, undo: StatusUndo)
	) {
		MaskinHaptics.play(.selection)
		picking.exit()
		Task {
			let outcome = await action()
			offerUndo(outcome.undo, message: "\(verb) \(outcome.undo.count). Undo.")
		}
	}

	private func offerUndo(_ undo: StatusUndo, message: String) {
		guard !undo.isEmpty else { return }
		undoOffer = UndoOffer(message: message) { await store.undo(undo) }
	}

	// MARK: Pieces

	// MARK: Asks

	/// Open decisions from the For You feed, keyed by object: they put a row under "Needs you" and
	/// give it its ask line. The same store the feed and the object page read.
	private var openAsks: [String: ObjectAsk] {
		guard let feed = appRuntime?.forYou.store else { return [:] }
		return ObjectAsk.map(from: feed.entries, senderName: { feed.senderName(of: $0) })
	}

	private func loadAsks() async {
		if let feed = appRuntime?.forYou.store, feed.phase == .idle { await feed.load() }
	}

	/// Swipe right-hand "Approve": take the agent's recommendation. One that can't be undone, or an
	/// ask with no recommendation, opens the object so its confirmation stays on the decision card.
	private func approve(_ ask: ObjectAsk) {
		guard let feed = appRuntime?.forYou.store, let option = ask.swipeApprove else {
			openObject?(ask.objectId)
			return
		}
		MaskinHaptics.play(.success)
		withAnimation(MaskinMotion.standard) { feed.choose(option, on: ask.card) }
		undoOffer = UndoOffer(message: "Approved: \(option.label). Undo.") {
			_ = feed.undo(ask.card)
		}
	}

	private func hold(_ ask: ObjectAsk, reason: String?) {
		guard let feed = appRuntime?.forYou.store, let option = ask.holdOption else { return }
		MaskinHaptics.play(.success)
		withAnimation(MaskinMotion.standard) { feed.choose(option, note: reason, on: ask.card) }
		undoOffer = UndoOffer(message: "Held. Undo.") { _ = feed.undo(ask.card) }
	}

	// MARK: Tabs

	/// Type tabs (handoff 8): Needs you (with its count), All, then one tab per type present. The
	/// active tab is an ink pill and scrolls to centre. The chevron opens the Go to sheet.
	private var typePicker: some View {
		let types = store.presentTypes
		return HStack(spacing: 0) {
			Button {
				MaskinHaptics.play(.selection)
				goingTo = true
			} label: {
				Image(systemName: "chevron.down.circle")
					.maskinSymbol(MaskinFontSize.t18)
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed(.shrink))
			.accessibilityLabel("Go to")
			ScrollViewReader { proxy in
				ScrollView(.horizontal, showsIndicators: false) {
					HStack(spacing: MaskinSpace.s1) {
						tabButton(.needsYou, "Needs you", count: store.needsYouCount, proxy: proxy)
						tabButton(.all, "All", proxy: proxy)
						ForEach(types, id: \.self) { type in
							tabButton(
								.type(type), ObjectTypeOrder.plural(store.directory.typeName(type)), proxy: proxy)
						}
					}
					.padding(.trailing, MaskinSpace.s9)
				}
			}
		}
		.padding(.leading, MaskinSpace.s2)
		.frame(minHeight: MaskinSpace.touchMin)
	}

	private func tabButton(
		_ tab: ObjectsTab, _ title: String, count: Int = 0, proxy: ScrollViewProxy
	) -> some View {
		let isSelected = store.tab == tab && !store.starredOnly
		let urgent = tab == .needsYou && count > 0
		return Button {
			MaskinHaptics.play(.selection)
			withAnimation(MaskinMotion.standard) { proxy.scrollTo(tab, anchor: .center) }
			Task {
				if store.starredOnly { await store.setStarredOnly(false) }
				await store.select(tab)
			}
		} label: {
			HStack(spacing: MaskinSpace.s3) {
				Text(title).maskinText(.body).fontWeight(.semibold)
				if urgent {
					Text("\(count)").maskinText(.caption).fontWeight(.bold)
						.foregroundStyle(isSelected ? MaskinSurface.onInverse : MaskinColor.sigInk)
				}
			}
			.foregroundStyle(
				isSelected ? MaskinSurface.onInverse : (urgent ? MaskinColor.sigInk : MaskinColor.ink4)
			)
			.padding(.horizontal, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s2)
			.background(
				isSelected ? MaskinSurface.inverse : (urgent ? MaskinColor.sigTint : Color.clear), in: Capsule()
			)
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Capsule())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.id(tab)
		.accessibilityAddTraits(isSelected ? .isSelected : [])
	}

	@ViewBuilder private var content: some View {
		if store.display.layout == .board {
			ObjectsBoardView(
				store: store, board: board, selection: selection, zoomNamespace: zoomNamespace,
				offerUndo: { message, undo in
					undoOffer = UndoOffer(message: message) { await undo() }
				})
		} else if store.objects.isEmpty || (store.visibleObjects.isEmpty && !store.hasMore) {
			emptyContent
				.id("empty")
		} else {
			list
		}
	}

	@ViewBuilder private var emptyContent: some View {
		switch store.phase {
		case .idle, .loading:
			ScrollView { LoadingSkeleton().padding(MaskinSpace.s9) }
		case .failed(let message):
			ScrollView {
				Group {
					if store.isOffline {
						AmberNotice.offline(since: store.freshness.updatedAt) { Task { await store.reload() } }
					} else {
						AmberNotice(
							title: "Couldn't load objects", message: message, actionTitle: "Retry"
						) { Task { await store.reload() } }
					}
				}
				.padding(MaskinSpace.s9)
			}
		case .loaded:
			ScrollView {
				if store.isFiltered && (store.statusFilter != nil || store.starredOnly || !store.searchText.isEmpty) {
					EmptyState(
						symbol: "magnifyingglass", title: "No matches",
						message: "Nothing fits these filters. Try a different type, status or word."
					) {
						Button("Clear filter") { clearFilters() }.buttonStyle(.secondaryAction)
					}
				} else if store.tab == .needsYou {
					EmptyState(
						symbol: "checkmark.circle", title: "All caught up",
						message: "Nothing in this list needs you right now.")
				} else if case .type(let type) = store.tab {
					let name = store.directory.typeName(type).lowercased()
					EmptyState(
						symbol: ObjectTypeOrder.symbol(for: type), title: "No \(ObjectTypeOrder.plural(name)) yet",
						message: "\(ObjectTypeOrder.plural(store.directory.typeName(type))) from you and your agents land here.")
				} else {
					EmptyState(
						symbol: "square.stack.3d.up", title: "Nothing here yet",
						message: "Insights, bets and tasks from you and your agents land here.")
				}
			}
			.refreshable { await store.reload() }
		}
	}

	private func clearFilters() {
		search = ""
		Task {
			await store.setStarredOnly(false)
			await store.setStatus(nil)
		}
	}

	private var list: some View {
		let rowSelection = Binding<String?>(
			get: { picking.isActive ? nil : selection?.wrappedValue },
			set: { id in
				if picking.isActive {
					if let id { picking.toggle(id) }
				} else {
					selection?.wrappedValue = id
				}
			})
		return List(selection: (selection != nil || picking.isActive) ? rowSelection : .constant(nil)) {
			if let error = store.actionError {
				FormError(error)
					.onTapGesture { store.clearActionError() }
					.listRowBackground(Color.clear)
			}
			ForEach(store.groups) { group in
				Section {
					if !store.isCollapsed(group) {
						ForEach(group.objects) { object in
							row(object)
						}
					}
				} header: {
					if group.title != nil {
						ObjectGroupHeader(
							group: group, isCollapsed: store.isCollapsed(group),
							toggle: {
								MaskinHaptics.play(.selection)
								withAnimation(MaskinMotion.standard) { store.toggleCollapsed(group) }
							})
					}
				}
			}
			if store.hasMore {
				HStack {
					Spacer()
					ProgressView()
					Spacer()
				}
				.listRowBackground(Color.clear)
				.task(id: store.objects.count) { await store.loadMore() }
			}
		}
		.modifier(InsetCardsListStyle())
		.scrollContentBackground(.hidden)
		.refreshable { await store.reload() }
	}

	/// The card behind a row; the picked row on a split view's selection takes the quiet fill.
	private func rowBackground(_ object: WorkObject) -> some View {
		let selected = selection?.wrappedValue == object.id && !picking.isActive
		return (selected ? MaskinSurface.fillStrong : MaskinSurface.card)
	}

	@ViewBuilder private func row(_ object: WorkObject) -> some View {
		let ask = store.asks[object.id]
		let content = ObjectRow(
			object: object, typeName: store.directory.typeName(object.type),
			ownerName: store.directory.name(for: object.driverId),
			ownerIsAgent: store.directory.actor(for: object.driverId)?.isAgent == true,
			ask: ask, needsYou: store.needsYou(object), showsTypeGlyph: store.mixesTypes,
			showsStatus: store.grouping != .status, showsDriver: store.display.shows(.driver),
			showsUpdated: store.display.shows(.updated), showsDriverName: sizeClass == .regular)
		Group {
			if picking.isActive {
				HStack(spacing: MaskinSpace.s5) {
					SelectionCheckbox(isPicked: picking.contains(object.id))
					content
				}
				.contentShape(Rectangle())
				.onTapGesture { picking.toggle(object.id) }
				.selectionRowAccessibility(isActive: true, isPicked: picking.contains(object.id))
				.accessibilityAddTraits(.isButton)
			} else if selection != nil {
				content.tag(object.id)
			} else {
				NavigationLink(value: ObjectRoute(id: object.id)) { content }
				.zoomSource(id: object.id, in: zoomNamespace)
			}
		}
		.listRowSeparatorTint(MaskinSurface.separator)
		.listRowBackground(rowBackground(object))
		.listRowInsets(
			EdgeInsets(
				top: MaskinSpace.s7, leading: MaskinSpace.s8, bottom: MaskinSpace.s7, trailing: MaskinSpace.s8))
		// The mockup puts both swipes on one side: Approve / Hold when an agent is waiting on you,
		// otherwise Archive / Done. The outer button is the full swipe.
		.swipeActions(edge: .trailing, allowsFullSwipe: true) {
			if !picking.isActive { swipeActions(for: object, ask: ask) }
		}
		.contextMenu {
			if !picking.isActive { menu(for: object, ask: ask) }
		}
	}

	@ViewBuilder private func swipeActions(for object: WorkObject, ask: ObjectAsk?) -> some View {
		if let ask {
			Button {
				approve(ask)
			} label: {
				Label("Approve", systemImage: "checkmark")
			}
			.tint(MaskinSurface.inverse)
			if ask.holdOption != nil {
				Button {
					holdTarget = ask
				} label: {
					Label("Hold", systemImage: "pause")
				}
				.tint(MaskinColor.ink4)
			}
		} else if store.needsYou(object), let target = store.approveTarget(for: object) {
			Button {
				MaskinHaptics.play(.selection)
				Task {
					if let undo = await store.approve(object.id) {
						offerUndo(undo, message: "Moved to \(MaskinStatus.label(for: target)). Undo.")
					}
				}
			} label: {
				Label("Approve", systemImage: "checkmark")
			}
			.tint(MaskinSurface.inverse)
		} else {
			if store.canArchive([object.id]) {
				Button {
					MaskinHaptics.play(.selection)
					runRecording([object.id], verb: "Archived") { await store.archive([object.id]) }
				} label: {
					Label("Archive", systemImage: "archivebox")
				}
				.tint(MaskinColor.dangerStrong)
			}
			if store.doneTarget(for: object) != nil {
				Button {
					MaskinHaptics.play(.selection)
					Task {
						if let undo = await store.markDone(object.id) { offerUndo(undo, message: "Done. Undo.") }
					}
				} label: {
					Label("Done", systemImage: "checkmark.circle")
				}
				.tint(MaskinColor.ink4)
			}
		}
	}

	@ViewBuilder private func menu(for object: WorkObject, ask: ObjectAsk?) -> some View {
		Button("Select", systemImage: "checkmark.circle") { picking.enter(selecting: object.id) }
		Button {
			statusTarget = object
		} label: {
			Label("Change status", systemImage: "circle.dashed")
		}
		Menu("Assign", systemImage: "person") {
			ForEach(assignees) { actor in
				Button(actor.name) {
					MaskinHaptics.play(.selection)
					Task { await store.assign([object.id], to: actor.id) }
				}
			}
		}
		Button {
			Task { await store.toggleStar(object.id) }
		} label: {
			Label(object.isStarred ? "Unstar" : "Star", systemImage: object.isStarred ? "star.slash" : "star")
		}
		if store.canArchive([object.id]) {
			Button {
				runRecording([object.id], verb: "Archived") { await store.archive([object.id]) }
			} label: {
				Label("Archive", systemImage: "archivebox")
			}
		}
		Button(role: .destructive) {
			pendingDelete = object
		} label: {
			Label("Delete", systemImage: "trash")
		}
	}
}

/// The Objects Display menu in the shell's pill: sort, "Needs you only", the properties a row shows,
/// list or board, then (list only) the status and starred filters and the grouping.
struct ObjectsDisplayMenu: View {
	@Bindable var store: ObjectsStore
	let picking: SelectionModel

	var body: some View {
		if store.display.layout == .list {
			Button("Select", systemImage: "checkmark.circle") { picking.enter() }
		}
		Section("Sort by") {
			Picker(
				"Sort by",
				selection: Binding(
					get: { store.display.sort },
					set: { value in Task { await store.setSort(value) } })
			) {
				ForEach(ObjectsSort.allCases) { Text($0.title).tag($0) }
			}
			.pickerStyle(.inline)
			.labelsHidden()
		}
		Section("Show") {
			ForEach(ObjectsProperty.allCases) { property in
				Toggle(
					property.title,
					isOn: Binding(
						get: { store.display.shows(property) },
						set: { _ in store.toggleProperty(property) }))
			}
		}
		Section("View") {
			Picker(
				"View",
				selection: Binding(
					get: { store.display.layout },
					set: { value in Task { await store.setLayout(value) } })
			) {
				ForEach(ObjectsLayout.allCases) { Text($0.title).tag($0) }
			}
			.pickerStyle(.inline)
			.labelsHidden()
		}
		if store.display.layout == .list {
			Divider()
			Picker(
				"Status",
				selection: Binding(
					get: { store.statusFilter ?? "" },
					set: { value in Task { await store.setStatus(value.isEmpty ? nil : value) } })
			) {
				Text("Any status").tag("")
				ForEach(store.statusOptions, id: \.self) { Text(MaskinStatus.label(for: $0)).tag($0) }
			}
			Toggle(
				"Starred only", systemImage: "star",
				isOn: Binding(
					get: { store.starredOnly },
					set: { value in Task { await store.setStarredOnly(value) } }))
			// Flow is not offered: the list payload carries no flow yet.
			Picker("Group by", selection: $store.grouping) {
				ForEach(ObjectsGrouping.allCases.filter { $0 != .attention }) { Text($0.title).tag($0) }
			}
		}
		if store.statusFilter != nil || store.starredOnly {
			Divider()
			Button("Clear filters", systemImage: "xmark.circle") {
				Task {
					await store.setStarredOnly(false)
					await store.setStatus(nil)
				}
			}
		}
	}
}

/// One inset card per group with hairline separators (iOS Settings, Things): `insetGrouped` on iOS,
/// the closest list style elsewhere.
private struct InsetCardsListStyle: ViewModifier {
	func body(content: Content) -> some View {
		#if os(iOS)
			content.listStyle(.insetGrouped)
		#else
			content.listStyle(.inset)
		#endif
	}
}
