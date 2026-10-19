import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Things the shell's Display menu asks the list to present (a sheet or an alert the menu
/// itself cannot host). Owned by the screen, like `SelectionModel`.
@MainActor
@Observable
final class ObjectsListIntents {
	var namingView = false
	var createStatus: String?
	var showCreate = false

	func create(status: String? = nil) {
		createStatus = status
		showCreate = true
	}
}

/// The list half of the Objects tab: large title with ▾ (Go to), type tabs, status groups as
/// inset cards (or the board), Select mode and the Undo toast. Rows link by value in a stack, or
/// drive `selection` in a split view (when `selection` is non-nil).
struct ObjectsListView: View {
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Bindable var store: ObjectsStore
	@Bindable var board: ObjectsBoardStore
	let selection: Binding<String?>?
	/// Set on iPhone, where a row pushes its detail with a zoom.
	var zoomNamespace: Namespace.ID?
	/// Owned by the screen so the Display menu's "Select" can start it.
	let picking: SelectionModel
	@Bindable var intents: ObjectsListIntents
	var askActions = ObjectAskActions()
	/// Opens an object from a board card or a context menu.
	var onOpen: (String) -> Void = { _ in }

	@Environment(\.horizontalSizeClass) private var sizeClass
	@State private var undoOffer: UndoOffer?
	@State private var search = ""
	@State private var searchPresented = false
	@State private var showGoTo = false
	@State private var holdTarget: ObjectAsk?
	@State private var viewName = ""

	var body: some View {
		Group {
			if store.display.layout == .board {
				board_
			} else {
				content
			}
		}
		.ambientBackground()
		.animation(.snappy, value: picking.isActive)
		// Select mode ends when the layout or scope changes.
		.onChange(of: store.display.layout) { picking.exit() }
		.onChange(of: store.scope) { picking.exit() }
		.onChange(of: allIDs) { picking.prune(toVisible: allIDs) }
		.selectionToolbar(picking, allIDs: allIDs, noun: "object") { bulkActions }
		.undoToast($undoOffer)
		.searchable(text: $search, isPresented: $searchPresented, prompt: "Search objects")
		.searchMinimized()
		// Closing the field collapses it back to the icon, so it can't keep a stale query.
		.onChange(of: searchPresented) { if !searchPresented, !search.isEmpty { search = "" } }
		.task(id: search) {
			if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
			if !Task.isCancelled { await store.setSearch(search) }
		}
		.sheet(isPresented: $showGoTo) {
			GoToSheet(
				store: store, onSelect: { scope in Task { await store.setScope(scope) } },
				onRemoveSavedView: { removeSavedView($0) })
		}
		.sheet(item: $holdTarget) { ask in
			// The For You hold sheet (reason, presets, Dictate, Skip), so both surfaces behave alike.
			HoldReasonSheet(agent: ask.askedBy) { reason in hold(ask, reason: reason) }
		}
		.sheet(isPresented: $intents.showCreate) {
			CreateObjectSheet(store: store, status: intents.createStatus)
		}
		.alert("Save as view", isPresented: $intents.namingView) {
			TextField("Name", text: $viewName)
			Button("Save") {
				store.saveCurrentView(named: viewName)
				viewName = ""
			}
			.disabled(viewName.trimmingCharacters(in: .whitespaces).isEmpty)
			Button("Cancel", role: .cancel) { viewName = "" }
		} message: {
			Text("Keeps the current tab, status, search, grouping and sort under a name.")
		}
	}

	// MARK: Header

	/// The large title (tap for Go to), type tabs and the active filter chip.
	private var header: some View {
		VStack(alignment: .leading, spacing: 0) {
			Button {
				MaskinHaptics.play(.light)
				showGoTo = true
			} label: {
				HStack(alignment: .center, spacing: MaskinSpace.s3) {
					Text(store.title)
						// iPhone's screen header already carries the big "Objects"; this stays as the Go to row.
						.maskinText(sizeClass == .compact ? .headline : .largeTitle)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1)
						.minimumScaleFactor(0.7)
					Image(systemName: "chevron.down")
						.maskinSymbol(MaskinFontSize.t16, weight: .bold)
						.foregroundStyle(MaskinColor.ink4)
						.padding(.top, sizeClass == .compact ? 0 : MaskinSpace.s3)
				}
				.frame(minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.padding(.horizontal, MaskinSpace.s11)
			.accessibilityLabel("\(store.title). Go to")
			.accessibilityHint("Opens the list of places to go")
			// iPhone shows the type tabs as chips in the screen header.
			if sizeClass != .compact {
				ObjectTypeTabs(tabs: ObjectTypeTab.tabs(for: store), selected: store.scope) { scope in
					Task { await store.setScope(scope) }
				}
				.padding(.top, MaskinSpace.s5)
			}
			if store.statusFilter != nil {
				filterChips.padding(.top, MaskinSpace.s5)
			}
			if store.isOffline && !store.objects.isEmpty {
				AmberNotice.offline(since: store.freshness.updatedAt) { Task { await store.reload() } }
					.padding(.horizontal, MaskinSpace.s9).padding(.top, MaskinSpace.s5)
			}
		}
		.padding(.bottom, MaskinSpace.s4)
	}

	private var filterChips: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s3) {
				if let status = store.statusFilter {
					Button {
						Task { await store.setStatus(nil) }
					} label: {
						HStack(spacing: MaskinSpace.s3) {
							Text(MaskinStatus.sentenceLabel(for: status))
							Image(systemName: "xmark").maskinSymbol(MaskinFontSize.t9, weight: .heavy)
						}
						.maskinText(.caption)
						.fontWeight(.semibold)
						.foregroundStyle(MaskinColor.sigInk)
						.padding(.leading, MaskinSpace.s7)
						.padding(.trailing, MaskinSpace.s4 + 1)
						.frame(height: MaskinSpace.s13 + MaskinSpace.s1)
						.background(MaskinColor.sigTint, in: Capsule())
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed(.shrink))
					.accessibilityLabel("Status \(MaskinStatus.sentenceLabel(for: status)). Remove filter")
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
		}
	}

	// MARK: Selection

	private var allIDs: [String] {
		if store.display.layout == .board {
			let needsYouOnly = store.needsYouOnly
			return board.shownColumns.flatMap { board.cards(in: $0, needsYouOnly: needsYouOnly).map(\.id) }
		}
		return store.groups.flatMap { $0.objects.map(\.id) }
	}

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
			if store.display.layout == .board { await board.refresh() }
			offerUndo(outcome.undo, message: "\(verb) \(outcome.undo.count). Undo.")
		}
	}

	private func offerUndo(_ undo: StatusUndo, message: String) {
		guard !undo.isEmpty else { return }
		undoOffer = UndoOffer(message: message) { await store.undo(undo) }
	}

	/// Removes the row now, sends the delete after the toast's window, Undo puts it back.
	private func deleteHeld(_ object: WorkObject) {
		MaskinHaptics.play(.selection)
		Task { await store.delete(object.id, holdFor: .seconds(6)) }
		undoOffer = UndoOffer(message: "Deleted. Undo.") { store.undoDelete(object.id) }
	}

	private func removeSavedView(_ id: String) {
		guard let removed = store.removeSavedView(id) else { return }
		undoOffer = UndoOffer(message: "Removed \(removed.view.name). Undo.") {
			store.restoreSavedView(removed.view, at: removed.index)
		}
	}

	private func hold(_ ask: ObjectAsk, reason: String?) {
		askActions.hold(ask, reason)
		undoOffer = UndoOffer(message: "Held. Undo.") { askActions.undo(ask) }
	}

	// MARK: Content

	@ViewBuilder private var content: some View {
		if store.objects.isEmpty || (store.visibleObjects.isEmpty && !store.hasMore) {
			emptyContent
				.id("empty")
		} else {
			list
		}
	}

	@ViewBuilder private var emptyContent: some View {
		switch store.phase {
		case .idle, .loading:
			ScrollView {
				header
				LoadingSkeleton().padding(MaskinSpace.s9)
			}
		case .failed(let message):
			ScrollView {
				header
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
				header
				emptyState.padding(MaskinSpace.s9)
			}
			.refreshable { await store.reload() }
		}
	}

	@ViewBuilder private var emptyState: some View {
		switch store.effectiveScope {
		case .needsYou where store.statusFilter == nil && store.searchText.isEmpty:
			EmptyState(
				symbol: "checkmark.circle", title: "Nothing needs you",
				message: "Agents are working. Asks for you land here."
			) {
				Button("See all objects") { Task { await store.setScope(.all) } }
					.buttonStyle(.primaryAction)
			}
		case .favourites where store.statusFilter == nil && store.searchText.isEmpty:
			EmptyState(
				symbol: "star", title: "No favourites yet",
				message: "Star an object and it lands here, on every device.")
		default:
			if store.isFiltered || store.display.needsYouOnly {
				EmptyState(
					symbol: "magnifyingglass",
					title: store.searchText.isEmpty ? "Nothing in this status" : "Nothing matches \u{201C}\(store.searchText.trimmingCharacters(in: .whitespaces))\u{201D}",
					message: "Nothing fits these filters. Try a different type, status or word."
				) {
					Button("Clear filter") {
						search = ""
						store.setNeedsYouOnly(false)
						Task {
							await store.setStatus(nil)
							await store.setScope(.all)
						}
					}
					.buttonStyle(.primaryAction)
				}
			} else {
				EmptyState(
					symbol: "square.stack.3d.up", title: "Nothing here yet",
					message: "Objects from you and your agents land here."
				) {
					Button("New object") { intents.create() }
						.buttonStyle(.primaryAction)
				}
			}
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
			Section {
				header
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			if let error = store.actionError {
				FormError(error)
					.onTapGesture { store.clearActionError() }
					.listRowBackground(Color.clear)
					.listRowSeparator(.hidden)
			}
			ForEach(store.groups) { group in
				groupSection(group)
			}
			if store.hasMore {
				HStack {
					Spacer()
					ProgressView()
					Spacer()
				}
				.listRowBackground(Color.clear)
				.listRowSeparator(.hidden)
				.task(id: store.objects.count) { await store.loadMore() }
			}
		}
		.listStyle(.plain)
		.compactSections()
		.scrollContentBackground(.hidden)
		.environment(\.defaultMinListRowHeight, MaskinSpace.touchMin)
		.refreshable { await store.reload() }
	}

	/// One inset card per group with hairline separators; the header folds it.
	@ViewBuilder private func groupSection(_ group: ObjectGroup) -> some View {
		let hasHeader = group.title != nil
		let collapsed = hasHeader && store.display.isCollapsed(group.id)
		Section {
			if hasHeader {
				ObjectGroupHeader(group: group, collapsed: collapsed) {
					withAnimation(reduceMotion ? nil : MaskinMotion.standard) { store.toggleGroup(group.id) }
				}
				.padding(.horizontal, MaskinSpace.s9)
				.listRowInsets(EdgeInsets())
				.listRowBackground(Color.clear)
				.listRowSeparator(.hidden)
			}
			if !collapsed {
				let count = group.objects.count
				ForEach(Array(group.objects.enumerated()), id: \.element.id) { index, object in
					row(object)
						.listRowInsets(EdgeInsets(top: MaskinSpace.s7, leading: MaskinSpace.s9 + MaskinSpace.s8, bottom: MaskinSpace.s7, trailing: MaskinSpace.s9 + MaskinSpace.s8))
						.listRowBackground(
							CardSlice(
								isFirst: index == 0, isLast: index == count - 1,
								selected: selection?.wrappedValue == object.id && !picking.isActive)
								.padding(.horizontal, MaskinSpace.s9))
						.listRowSeparatorTint(MaskinSurface.separator)
						.listRowSeparator(index == 0 ? .hidden : .visible, edges: .top)
						.listRowSeparator(index == count - 1 ? .hidden : .visible, edges: .bottom)
						.alignmentGuide(.listRowSeparatorLeading) { d in d[.leading] + MaskinSpace.s9 }
						.alignmentGuide(.listRowSeparatorTrailing) { d in d[.trailing] - MaskinSpace.s9 }
				}
			}
		}
	}

	@ViewBuilder private func row(_ object: WorkObject) -> some View {
		let ask = store.ask(for: object.id)
		let content = ObjectListRow(
			object: object, typeName: store.directory.typeName(object.type),
			subtitle: store.display.rowSubtitle(
				typeName: store.directory.typeName(object.type),
				driver: store.directory.name(for: object.driverId),
				age: object.updatedAt.map { RelativeTimeFormatter.string(for: $0, now: Date(), style: .compact) }),
			ask: ask, showsStatus: store.display.shows(.status))
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
		.swipeActions(edge: .leading, allowsFullSwipe: true) {
			if !picking.isActive {
				if let ask {
					Button {
						MaskinHaptics.play(.success)
						askActions.approve(ask)
						undoOffer = UndoOffer(message: "Approved. Undo.") { askActions.undo(ask) }
					} label: {
						Label("Approve", systemImage: "checkmark")
					}
					.tint(MaskinSurface.inverse)
				} else if ObjectsUrgency.needsYou(object), let target = store.approveTarget(for: object) {
					Button {
						MaskinHaptics.play(.success)
						Task {
							if let undo = await store.approve(object.id) {
								offerUndo(undo, message: "Moved to \(MaskinStatus.label(for: target)). Undo.")
							}
						}
					} label: {
						Label("Approve", systemImage: "checkmark")
					}
					.tint(MaskinSurface.inverse)
				} else if store.doneTarget(for: object) != nil {
					Button {
						MaskinHaptics.play(.success)
						Task {
							if let undo = await store.markDone(object.id) { offerUndo(undo, message: "Marked done. Undo.") }
						}
					} label: {
						Label("Done", systemImage: "checkmark")
					}
					.tint(MaskinSurface.inverse)
				}
			}
		}
		.swipeActions(edge: .trailing, allowsFullSwipe: true) {
			if !picking.isActive {
				if let ask {
					Button {
						MaskinHaptics.play(.selection)
						holdTarget = ask
					} label: {
						Label("Hold", systemImage: "pause")
					}
					.tint(MaskinColor.ink4)
				} else if store.canArchive([object.id]) {
					Button {
						MaskinHaptics.play(.selection)
						Task {
							if let undo = await store.archive(object.id) { offerUndo(undo, message: "Archived. Undo.") }
						}
					} label: {
						Label("Archive", systemImage: "archivebox")
					}
					.tint(MaskinColor.ink4)
				} else {
					Button {
						deleteHeld(object)
					} label: {
						Label("Delete", systemImage: "trash")
					}
					.tint(MaskinColor.ink4)
				}
			}
		}
		.contextMenu {
			if !picking.isActive {
				ObjectMenuItems(
					object: object, ask: ask, store: store, askActions: askActions,
					onHold: { holdTarget = $0 }, offerUndo: { offerUndo($0, message: $1) },
					deleteHeld: deleteHeld, onOpen: { onOpen(object.id) },
					onSelect: { picking.enter(selecting: object.id) })
			}
		}
	}

	// MARK: Board

	private var board_: some View {
		ScrollView {
			header
			ObjectsBoardView(
				store: store, board: board, selection: selection, picking: picking, zoomNamespace: zoomNamespace,
				offerUndo: { message, undo in
					undoOffer = UndoOffer(message: message) { await undo() }
				},
				onNew: { status in intents.create(status: status) })
		}
	}
}

/// A row's slice of its group card: top corners on the first row, bottom corners on the last,
/// the card's hairline border down both sides (and across the ends).
struct CardSlice: View {
	let isFirst: Bool
	let isLast: Bool
	var selected = false

	var body: some View {
		let r = MaskinRadius.card2xl
		UnevenRoundedRectangle(
			cornerRadii: RectangleCornerRadii(
				topLeading: isFirst ? r : 0, bottomLeading: isLast ? r : 0, bottomTrailing: isLast ? r : 0,
				topTrailing: isFirst ? r : 0),
			style: .continuous)
		.fill(selected ? MaskinSurface.fillStrong : MaskinSurface.card)
		.overlay {
			CardSliceBorder(isFirst: isFirst, isLast: isLast, radius: r)
				.stroke(MaskinSurface.line, lineWidth: 1)
		}
	}
}

/// The open outline of a card slice: sides always, top only on the first row, bottom only on the last.
struct CardSliceBorder: Shape {
	let isFirst: Bool
	let isLast: Bool
	let radius: CGFloat

	func path(in rect: CGRect) -> Path {
		let r = rect.insetBy(dx: 0.5, dy: 0)
		let top = isFirst ? r.minY + 0.5 : r.minY
		let bottom = isLast ? r.maxY - 0.5 : r.maxY
		let c = radius
		var p = Path()
		// Left side, up to the top edge.
		p.move(to: CGPoint(x: r.minX, y: bottom - (isLast ? c : 0)))
		p.addLine(to: CGPoint(x: r.minX, y: top + (isFirst ? c : 0)))
		if isFirst {
			p.addArc(
				center: CGPoint(x: r.minX + c, y: top + c), radius: c, startAngle: .degrees(180),
				endAngle: .degrees(270), clockwise: false)
			p.addLine(to: CGPoint(x: r.maxX - c, y: top))
			p.addArc(
				center: CGPoint(x: r.maxX - c, y: top + c), radius: c, startAngle: .degrees(270),
				endAngle: .degrees(0), clockwise: false)
		} else {
			p.move(to: CGPoint(x: r.maxX, y: top))
		}
		// Right side, down to the bottom edge.
		p.addLine(to: CGPoint(x: r.maxX, y: bottom - (isLast ? c : 0)))
		if isLast {
			p.addArc(
				center: CGPoint(x: r.maxX - c, y: bottom - c), radius: c, startAngle: .degrees(0),
				endAngle: .degrees(90), clockwise: false)
			p.addLine(to: CGPoint(x: r.minX + c, y: bottom))
			p.addArc(
				center: CGPoint(x: r.minX + c, y: bottom - c), radius: c, startAngle: .degrees(90),
				endAngle: .degrees(180), clockwise: false)
		}
		return p
	}
}

extension View {
	/// Tightens the gap between list sections where the platform lets us.
	fileprivate func compactSections() -> some View {
		#if os(iOS)
			return listSectionSpacing(MaskinSpace.s2)
		#else
			return self
		#endif
	}
}

/// The Objects Display menu in the shell's pill: list or board, group by, sort, status filter,
/// shown properties, saved views, Select and New.
struct ObjectsDisplayMenu: View {
	@Bindable var store: ObjectsStore
	let picking: SelectionModel
	let intents: ObjectsListIntents

	var body: some View {
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
		Menu {
			Picker("Group by", selection: Binding(get: { store.display.groupBy }, set: { store.setGrouping($0) })) {
				ForEach(ObjectsGrouping.allCases) { Text($0.title).tag($0) }
			}
		} label: {
			Label("Group by \u{00B7} \(store.display.groupBy.title)", systemImage: "rectangle.3.group")
		}
		Menu {
			Picker(
				"Sort by",
				selection: Binding(
					get: { store.display.sort },
					set: { value in Task { await store.setSort(value) } })
			) {
				ForEach(ObjectsSort.allCases) { Text($0.title).tag($0) }
			}
		} label: {
			Label("Sort by \u{00B7} \(store.display.sort.title)", systemImage: "arrow.up.arrow.down")
		}
		Menu {
			Picker(
				"Status",
				selection: Binding(
					get: { store.statusFilter ?? "" },
					set: { value in Task { await store.setStatus(value.isEmpty ? nil : value) } })
			) {
				Text("Any status").tag("")
				ForEach(store.statusOptions, id: \.self) { Text(MaskinStatus.sentenceLabel(for: $0)).tag($0) }
			}
		} label: {
			Label(
				store.statusFilter.map { "Status: \(MaskinStatus.sentenceLabel(for: $0))" } ?? "Status",
				systemImage: store.statusFilter == nil ? "circle.dashed" : "circle.dashed.inset.filled")
		}
		Toggle(
			"Needs you only", systemImage: "circle.fill",
			isOn: Binding(
				get: { store.display.needsYouOnly },
				set: { store.setNeedsYouOnly($0) }))
		Menu {
			ForEach(ObjectsProperty.allCases) { property in
				Toggle(
					property.title,
					isOn: Binding(
						get: { store.display.shows(property) },
						set: { _ in store.toggleProperty(property) }))
			}
		} label: {
			Label("Show on each row", systemImage: "eye")
		}
		Section("Saved views") {
			Button("Save as view", systemImage: "bookmark") { intents.namingView = true }
			if case .saved(let id) = store.scope {
				Button(role: .destructive) {
					_ = store.removeSavedView(id)
				} label: {
					Label("Remove this view", systemImage: "bookmark.slash")
				}
			}
		}
		Section {
			Button("Select", systemImage: "checkmark.circle") { picking.enter() }
			Button("New object", systemImage: "plus") { intents.create() }
		}
		if store.statusFilter != nil || store.display.needsYouOnly || store.display.isCustomised {
			Divider()
			Button("Reset display", systemImage: "xmark.circle") {
				store.setNeedsYouOnly(false)
				store.setGrouping(ObjectsDisplay.defaultGrouping)
				Task {
					await store.setStatus(nil)
					await store.setSort(.needsYou)
					await store.setLayout(.list)
				}
			}
		}
	}
}
