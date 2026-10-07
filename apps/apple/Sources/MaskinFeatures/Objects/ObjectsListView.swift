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

	@State private var search = ""
	@State private var searchPresented = false
	@State private var pendingDelete: WorkObject?
	@State private var statusTarget: WorkObject?
	@State private var picking = SelectionModel()
	@State private var confirmBulkDelete = false

	var body: some View {
		VStack(spacing: 0) {
			typePicker
			if store.isOffline && !store.objects.isEmpty {
				OfflineBanner().padding(.horizontal, MaskinSpace.s9).padding(.bottom, MaskinSpace.s4)
			}
			content
		}
		.ambientBackground()
		.animation(.snappy, value: picking.isActive)
		// Selection belongs to the list; leaving it for the board ends it.
		.onChange(of: store.display.layout) { picking.exit() }
		.onChange(of: allIDs) { picking.prune(toVisible: allIDs) }
		.selectionToolbar(picking, allIDs: allIDs, noun: "object") { bulkActions }
		.confirmationDialog(
			"Delete \(picking.count) \(picking.count == 1 ? "object" : "objects")?",
			isPresented: $confirmBulkDelete, titleVisibility: .visible
		) {
			Button("Delete", role: .destructive) {
				let ids = picking.ordered(in: allIDs)
				picking.exit()
				Task { await store.delete(ids) }
			}
		} message: {
			Text("This can't be undone.")
		}
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

	/// Status, star and delete over the picked objects, as text in the selection bar.
	@ViewBuilder private var bulkActions: some View {
		let ids = picking.ordered(in: allIDs)
		Menu("More") {
			Menu("Status", systemImage: "circle.dashed") {
				ForEach(store.statusOptions, id: \.self) { status in
					Button(MaskinStatus.label(for: status)) { run { await store.setStatus(ids, to: status) } }
				}
			}
			Button("Star", systemImage: "star") { run { await store.setStarred(ids, true) } }
			Button("Unstar", systemImage: "star.slash") { run { await store.setStarred(ids, false) } }
		}
		.disabled(picking.isEmpty)
		Button("Delete", role: .destructive) { confirmBulkDelete = true }
			.fontWeight(.semibold)
			.disabled(picking.isEmpty)
	}

	private func run(_ action: @escaping () async -> BulkResult) {
		MaskinHaptics.play(.selection)
		picking.exit()
		Task { _ = await action() }
	}

	// MARK: Pieces

	/// Type tabs: a scrolling row of text tabs, the selected one on a quiet fill.
	private var typePicker: some View {
		let selected = store.typeFilter ?? ""
		let types = [""] + store.presentTypes
		return ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s2) {
				ForEach(types, id: \.self) { type in
					Button {
						Task { await store.setType(type.isEmpty ? nil : type) }
					} label: {
						Text(type.isEmpty ? "All" : store.directory.typeName(type))
							.maskinText(.subhead)
							.fontWeight(type == selected ? .semibold : .regular)
							.foregroundStyle(type == selected ? MaskinColor.ink : MaskinColor.ink4)
							.padding(.horizontal, MaskinSpace.s6)
							.frame(minHeight: MaskinSpace.s14)
							.background(
								type == selected ? MaskinSurface.fill : Color.clear, in: Capsule())
							.contentShape(Capsule())
					}
					.buttonStyle(.plain)
					.accessibilityAddTraits(type == selected ? .isSelected : [])
				}
			}
			.padding(.horizontal, MaskinSpace.s9)
		}
		.padding(.vertical, MaskinSpace.s2)
	}

	@ViewBuilder private var content: some View {
		if store.display.layout == .board {
			ObjectsBoardView(store: store, board: board, selection: selection, zoomNamespace: zoomNamespace)
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
				VStack(spacing: MaskinSpace.s7) {
					OfflineBanner(isVisible: store.isOffline)
					EmptyState(
						symbol: "exclamationmark.triangle", title: "Couldn't load objects", message: message
					) {
						Button("Try again") { Task { await store.reload() } }
							.buttonStyle(.secondaryAction)
					}
				}
				.padding(MaskinSpace.s9)
			}
		case .loaded:
			ScrollView {
				if store.display.needsYouOnly && !store.isFiltered {
					EmptyState(
						symbol: "checkmark.circle", title: "Nothing here yet",
						message: "Nothing in this list needs you right now.")
				} else if store.isFiltered {
					EmptyState(
						symbol: "magnifyingglass", title: "No matches",
						message: "Nothing fits these filters. Try a different type, status or word.")
				} else {
					EmptyState(
						symbol: "square.stack.3d.up", title: "Nothing here yet",
						message: "Insights, bets and tasks from you and your agents land here."
					)
				}
			}
			.refreshable { await store.reload() }
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
					ForEach(group.objects) { object in
						row(object)
					}
				} header: {
					if group.title != nil { ObjectGroupHeader(group: group) }
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
		.listStyle(.plain)
		.scrollContentBackground(.hidden)
		.refreshable { await store.reload() }
	}

	/// The card behind a row; the picked row on a split view's selection takes the quiet fill.
	private func rowBackground(_ object: WorkObject) -> some View {
		let selected = selection?.wrappedValue == object.id && !picking.isActive
		return RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)
			.fill(selected ? MaskinSurface.fillStrong : MaskinSurface.card)
			.padding(.vertical, MaskinSpace.s2)
	}

	@ViewBuilder private func row(_ object: WorkObject) -> some View {
		let content = ObjectRow(
			object: object, typeName: store.directory.typeName(object.type),
			ownerName: store.directory.name(for: object.driverId),
			ownerIsAgent: store.directory.actor(for: object.driverId)?.isAgent == true,
			showsStatus: store.grouping != .status, showsDriver: store.display.shows(.driver),
			showsUpdated: store.display.shows(.updated))
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
		.listRowSeparator(.hidden)
		.listRowBackground(rowBackground(object))
		.listRowInsets(
			EdgeInsets(
				top: MaskinSpace.s4, leading: MaskinSpace.s9, bottom: MaskinSpace.s4, trailing: MaskinSpace.s9))
		.swipeActions(edge: .leading) {
			if !picking.isActive { Button {
				MaskinHaptics.play(.selection)
				Task { await store.toggleStar(object.id) }
			} label: {
				Label(object.isStarred ? "Unstar" : "Star", systemImage: object.isStarred ? "star.slash" : "star")
			}
			.tint(MaskinColor.ink) }
		}
		.swipeActions(edge: .trailing) {
			if !picking.isActive {
			Button(role: .destructive) {
				pendingDelete = object
			} label: {
				Label("Delete", systemImage: "trash")
			}
			Button {
				statusTarget = object
			} label: {
				Label("Status", systemImage: "circle.dashed")
			}
			.tint(MaskinColor.ink3)
			}
		}
		.contextMenu {
			if !picking.isActive {
			Button("Select", systemImage: "checkmark.circle") { picking.enter(selecting: object.id) }
			Button {
				statusTarget = object
			} label: {
				Label("Change status", systemImage: "circle.dashed")
			}
			Button {
				Task { await store.toggleStar(object.id) }
			} label: {
				Label(object.isStarred ? "Unstar" : "Star", systemImage: object.isStarred ? "star.slash" : "star")
			}
			Button(role: .destructive) {
				pendingDelete = object
			} label: {
				Label("Delete", systemImage: "trash")
			}
			}
		}
	}
}

/// The Objects Display menu in the shell's pill: sort, "Needs you only", the properties a row shows,
/// list or board, then (list only) the status and starred filters and the grouping.
struct ObjectsDisplayMenu: View {
	@Bindable var store: ObjectsStore

	var body: some View {
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
		Toggle(
			"Needs you only", systemImage: "circle.fill",
			isOn: Binding(
				get: { store.display.needsYouOnly },
				set: { store.setNeedsYouOnly($0) }))
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
			Picker("Group by", selection: $store.grouping) {
				ForEach(ObjectsGrouping.allCases) { Text($0.title).tag($0) }
			}
		}
		if store.statusFilter != nil || store.starredOnly || store.display.needsYouOnly {
			Divider()
			Button("Clear filters", systemImage: "xmark.circle") {
				store.setNeedsYouOnly(false)
				Task {
					await store.setStarredOnly(false)
					await store.setStatus(nil)
				}
			}
		}
	}
}
