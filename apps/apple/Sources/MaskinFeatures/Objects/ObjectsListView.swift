import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The list half of the Objects tab. Rows link by value in a stack, or drive `selection` in a
/// split view (when `selection` is non-nil).
struct ObjectsListView: View {
	@Bindable var store: ObjectsStore
	let selection: Binding<String?>?
	/// Set on iPhone, where a row pushes its detail with a zoom.
	var zoomNamespace: Namespace.ID?

	@State private var search = ""
	@State private var searchPresented = false
	@State private var pendingDelete: WorkObject?
	@State private var statusTarget: WorkObject?

	var body: some View {
		VStack(spacing: 0) {
			typePicker
			if store.isOffline && !store.objects.isEmpty {
				OfflineBanner().padding(.horizontal, MaskinSpace.s9).padding(.bottom, MaskinSpace.s4)
			}
			content
		}
		.background(MaskinSurface.grouped)
		.searchable(text: $search, isPresented: $searchPresented, prompt: "Search objects")
		.searchMinimized()
		// Closing the field collapses it back to the icon, so it can't keep a stale query.
		.onChange(of: searchPresented) { if !searchPresented { search = "" } }
		.task(id: search) {
			if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
			if !Task.isCancelled { await store.setSearch(search) }
		}
		.toolbar {
			ToolbarItem(placement: .primaryAction) { filterMenu }
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

	// MARK: Pieces

	/// Type tabs: a scrolling row of text tabs, the selected one on a quiet fill.
	private var typePicker: some View {
		let selected = store.typeFilter ?? ""
		let types = [""] + store.directory.schema.types
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

	private var filterMenu: some View {
		Menu {
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
			if store.statusFilter != nil || store.starredOnly {
				Divider()
				Button("Clear filters", systemImage: "xmark.circle") {
					Task {
						await store.setStarredOnly(false)
						await store.setStatus(nil)
					}
				}
			}
		} label: {
			Label(
				"Filter",
				systemImage: store.statusFilter == nil && !store.starredOnly
					? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
		}
	}

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
				if store.isFiltered {
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
		List(selection: selection ?? .constant(nil)) {
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
		.refreshable { await store.reload() }
	}

	@ViewBuilder private func row(_ object: WorkObject) -> some View {
		let content = ObjectRow(
			object: object, typeName: store.directory.typeName(object.type),
			ownerName: store.directory.name(for: object.driverId),
			ownerIsAgent: store.directory.actor(for: object.driverId)?.isAgent == true,
			showsStatus: store.grouping == .none)
		Group {
			if selection != nil {
				content.tag(object.id)
			} else {
				NavigationLink(value: ObjectRoute(id: object.id)) { content }
				.zoomSource(id: object.id, in: zoomNamespace)
			}
		}
		.listRowSeparator(.hidden)
		.swipeActions(edge: .leading) {
			Button {
				MaskinHaptics.play(.selection)
				Task { await store.toggleStar(object.id) }
			} label: {
				Label(object.isStarred ? "Unstar" : "Star", systemImage: object.isStarred ? "star.slash" : "star")
			}
			.tint(MaskinColor.accent)
		}
		.swipeActions(edge: .trailing) {
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
		.contextMenu {
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
