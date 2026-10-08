import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Object types of the workspace; each opens its properties and statuses.
struct ObjectTypesView: View {
	@State private var store: SchemaStore

	init(store: SchemaStore) { _store = State(initialValue: store) }

	var body: some View {
		List {
			ForEach(store.schema.types, id: \.self) { type in
				NavigationLink {
					ObjectTypeDetailView(store: store, type: type)
				} label: {
					SettingsRow(
						symbol: "square.stack.3d.up", title: store.schema.displayName(for: type),
						detail: "\(store.properties(of: type).count) properties")
				}
			}
			if let error = store.actionError { Section { FormError(error) } }
		}
		.settingsListStyle()
		.overlay {
			switch store.phase {
			case .loading: ProgressView()
			case .failed(let message):
				ContentUnavailableView(
					"Couldn't load object types", systemImage: "wifi.exclamationmark",
					description: Text(message))
			default: EmptyView()
			}
		}
		.navigationTitle("Object types")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.task { await store.load() }
		.refreshable { await store.load() }
	}
}

/// One type's properties and statuses.
struct ObjectTypeDetailView: View {
	let store: SchemaStore
	let type: String
	@State private var editor: PropertyEditorTarget?
	@State private var newStatus = ""
	@State private var pendingPropertyRemoval: PropertyDefinition?

	var body: some View {
		List {
			Section {
				ForEach(store.properties(of: type)) { property in
					Button { editor = .edit(property) } label: {
						VStack(alignment: .leading, spacing: MaskinSpace.s1) {
							Text(property.name).foregroundStyle(MaskinColor.ink)
							Text(detail(property)).font(.footnote).foregroundStyle(MaskinColor.ink4)
						}
						.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
						.frame(maxWidth: .infinity, alignment: .leading)
						.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
					.swipeActions(edge: .trailing) {
						if store.canEdit {
							Button("Remove", role: .destructive) { pendingPropertyRemoval = property }
						}
					}
				}
				if store.canEdit {
					Button("Add property", systemImage: "plus") { editor = .new }
						.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				}
			} header: {
				Text("Properties")
			} footer: {
				if store.properties(of: type).isEmpty { Text("This type has no custom properties yet.") }
			}
			Section {
				ForEach(store.statuses(of: type), id: \.self) { status in
					Text(status.replacingOccurrences(of: "_", with: " ").capitalized)
						.foregroundStyle(MaskinColor.ink)
						.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
						.swipeActions(edge: .trailing) {
							if store.canEdit && store.statuses(of: type).count > 1 {
								Button("Remove", role: .destructive) {
									Task { await store.removeStatus(status, from: type) }
								}
							}
						}
				}
				.onMove { offsets, destination in
					Task { await store.moveStatuses(of: type, from: offsets, to: destination) }
				}
				if store.canEdit {
					HStack {
						TextField("New status", text: $newStatus)
							.submitLabel(.done)
							.onSubmit(addStatus)
						Button("Add", action: addStatus)
							.disabled(!SchemaStore.isValidStatus(newStatus))
					}
					.frame(minHeight: MaskinSpace.touchMin)
				}
			} header: {
				Text("Statuses")
			} footer: {
				Text("Statuses show in this order. Swipe to remove one.")
			}
			if let error = store.actionError { Section { FormError(error) } }
			if !store.canEdit {
				Section { } footer: { Text("Only a workspace admin can change object types.") }
			}
		}
		.settingsListStyle()
		.navigationTitle(store.schema.displayName(for: type))
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			.toolbar { if store.canEdit && store.statuses(of: type).count > 1 { EditButton() } }
		#endif
		.sheet(item: $editor) { target in
			PropertyEditorSheet(store: store, type: type, target: target)
		}
		.confirmationDialog(
			pendingPropertyRemoval.map { "Remove \($0.name)?" } ?? "Remove property?",
			isPresented: Binding(
				get: { pendingPropertyRemoval != nil },
				set: { if !$0 { pendingPropertyRemoval = nil } }),
			titleVisibility: .visible, presenting: pendingPropertyRemoval
		) { property in
			Button("Remove property", role: .destructive) {
				Task { await store.removeProperty(property.name, from: type) }
			}
		} message: { _ in
			Text("Existing values stay on objects but are no longer shown as a field.")
		}
		.onAppear { store.dismissError() }
	}

	private func addStatus() {
		let status = newStatus
		guard SchemaStore.isValidStatus(status) else { return }
		Task { if await store.addStatus(status, to: type) { newStatus = "" } }
	}

	private func detail(_ property: PropertyDefinition) -> String {
		var parts = [property.kind.label]
		if property.kind == .enum, !property.values.isEmpty {
			parts.append(property.values.joined(separator: ", "))
		}
		if property.isRequired { parts.append("Required") }
		return parts.joined(separator: " · ")
	}
}

enum PropertyEditorTarget: Identifiable {
	case new
	case edit(PropertyDefinition)

	var id: String {
		switch self {
		case .new: "new"
		case .edit(let property): property.name
		}
	}
}

struct PropertyEditorSheet: View {
	@Environment(\.dismiss) private var dismiss
	let store: SchemaStore
	let type: String
	let target: PropertyEditorTarget
	@State private var name = ""
	@State private var kind: PropertyDefinition.Kind = .text
	@State private var isRequired = false
	@State private var valuesText = ""
	@State private var original: String?

	private var draft: PropertyDefinition {
		PropertyDefinition(
			name: name, kind: kind, isRequired: isRequired,
			values: SchemaStore.parseValues(valuesText))
	}

	private var canSave: Bool {
		!store.isSaving && store.problem(with: draft, on: type, replacing: original) == nil
	}

	var body: some View {
		NavigationStack {
			Form {
				Section("Name") {
					TextField("Property name", text: $name)
						.autocorrectionDisabled()
						.frame(minHeight: MaskinSpace.touchMin)
				}
				Section("Type") {
					Picker("Type", selection: $kind) {
						ForEach(PropertyDefinition.Kind.allCases, id: \.self) { Text($0.label).tag($0) }
					}
					if kind == .enum {
						TextField("Choices, separated by commas", text: $valuesText)
							.autocorrectionDisabled()
					}
					Toggle("Required", isOn: $isRequired)
				}
				if let error = store.actionError { Section { FormError(error) } }
			}
			.settingsListStyle()
			.navigationTitle(original == nil ? "New property" : "Edit property")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") {
						Task {
							let ok: Bool
							if let original {
								ok = await store.updateProperty(draft, original: original, on: type)
							} else {
								ok = await store.addProperty(draft, to: type)
							}
							if ok { dismiss() }
						}
					}
					.disabled(!canSave)
				}
			}
			.onAppear {
				store.dismissError()
				if case .edit(let property) = target {
					original = property.name
					name = property.name
					kind = property.kind
					isRequired = property.isRequired
					valuesText = property.values.joined(separator: ", ")
				}
			}
		}
		.presentationDetents([.medium, .large])
	}
}
