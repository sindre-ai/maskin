import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The list half of the Objects tab. Rows link by value in a stack, or drive `selection` in a
/// split view (when `selection` is non-nil).
struct ObjectsListView: View {
	@Bindable var store: ObjectsStore
	let selection: Binding<String?>?
	var onCreated: (WorkObject) -> Void = { _ in }

	@State private var search = ""
	@State private var creating = false
	@State private var pendingDelete: WorkObject?

	var body: some View {
		VStack(spacing: 0) {
			typePicker
			if store.isOffline && !store.objects.isEmpty {
				OfflineBanner().padding(.horizontal, MaskinSpace.s9).padding(.bottom, MaskinSpace.s4)
			}
			content
		}
		.background(MaskinSurface.grouped)
		.navigationTitle("Objects")
		.searchable(text: $search, prompt: "Search objects")
		.task(id: search) {
			if !search.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
			if !Task.isCancelled { await store.setSearch(search) }
		}
		.toolbar {
			ToolbarItemGroup(placement: .primaryAction) {
				filterMenu
				Button {
					creating = true
				} label: {
					Label("New object", systemImage: "plus")
				}
			}
		}
		.sheet(isPresented: $creating) {
			CreateObjectSheet(store: store) { onCreated($0) }
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

	private var typePicker: some View {
		Picker(
			"Type",
			selection: Binding(
				get: { store.typeFilter ?? "" },
				set: { value in Task { await store.setType(value.isEmpty ? nil : value) } })
		) {
			Text("All").tag("")
			ForEach(store.directory.schema.types, id: \.self) { type in
				Text(store.directory.typeName(type)).tag(type)
			}
		}
		.pickerStyle(.segmented)
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.vertical, MaskinSpace.s5)
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
			Picker("Group by", selection: $store.grouping) {
				ForEach(ObjectsGrouping.allCases) { Text($0.title).tag($0) }
			}
		} label: {
			Label(
				"Filter",
				systemImage: store.statusFilter == nil
					? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
		}
	}

	@ViewBuilder private var content: some View {
		if store.objects.isEmpty {
			emptyContent
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
						message: "Nothing fits these filters. Try a different type, status or search.")
				} else {
					EmptyState(
						symbol: "square.stack.3d.up", title: "No objects yet",
						message: "Insights, bets and tasks created by you and your agents show up here."
					) {
						Button("New object") { creating = true }.buttonStyle(.primaryAction)
					}
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
				.task { await store.loadMore() }
			}
		}
		.scrollContentBackground(.hidden)
		#if os(iOS)
			.listStyle(.insetGrouped)
		#endif
		.refreshable { await store.reload() }
	}

	@ViewBuilder private func row(_ object: WorkObject) -> some View {
		let content = ObjectRow(
			object: object, typeName: store.directory.typeName(object.type),
			ownerName: store.directory.name(for: object.driverId),
			showsStatus: store.grouping == .none)
		Group {
			if selection != nil {
				content.tag(object.id)
			} else {
				NavigationLink(value: ObjectRoute(id: object.id)) { content }
			}
		}
		.listRowBackground(MaskinSurface.card)
		.swipeActions(edge: .leading) {
			Button {
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
		}
		.contextMenu {
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
