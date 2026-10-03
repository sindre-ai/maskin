import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// New insight / bet / task. One idempotency key per sheet, so a retried save after a lost
/// response can't create the object twice.
struct CreateObjectSheet: View {
	let store: ObjectsStore
	var onCreated: (WorkObject) -> Void = { _ in }

	@Environment(\.dismiss) private var dismiss
	@State private var draft: ObjectDraft
	@State private var key = IdempotencyKey.make()
	@State private var isSaving = false
	@State private var failure: String?

	init(store: ObjectsStore, onCreated: @escaping (WorkObject) -> Void = { _ in }) {
		self.store = store
		self.onCreated = onCreated
		let type = store.typeFilter ?? store.directory.schema.types.first ?? "task"
		_draft = State(
			initialValue: ObjectDraft(
				type: type, status: store.directory.schema.statuses(for: type).first ?? "new"))
	}

	private var statuses: [String] { store.directory.schema.statuses(for: draft.type) }

	var body: some View {
		NavigationStack {
			Form {
				Section {
					Picker("Type", selection: $draft.type) {
						ForEach(store.directory.schema.types, id: \.self) {
							Text(store.directory.typeName($0)).tag($0)
						}
					}
					.pickerStyle(.segmented)
					.listRowBackground(Color.clear)
					.onChange(of: draft.type) { _, type in
						let options = store.directory.schema.statuses(for: type)
						if !options.contains(draft.status), let first = options.first { draft.status = first }
					}
				}
				Section("Title") {
					TextField("What is it?", text: $draft.title, axis: .vertical)
						.lineLimit(1...3)
				}
				Section("Details") {
					TextField("Add context (markdown supported)", text: $draft.content, axis: .vertical)
						.lineLimit(4...12)
				}
				Section {
					Picker("Status", selection: $draft.status) {
						ForEach(statuses, id: \.self) { Text(MaskinStatus.label(for: $0)).tag($0) }
					}
				}
				if let failure {
					Section { FormError(failure) }
				}
			}
			.navigationTitle("New \(store.directory.typeName(draft.type).lowercased())")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button("Cancel") { dismiss() }
				}
				ToolbarItem(placement: .confirmationAction) {
					Button("Create") { save() }
						.disabled(!draft.isValid || isSaving)
				}
			}
		}
		.presentationDetents([.large])
		.interactiveDismissDisabled(isSaving)
	}

	private func save() {
		isSaving = true
		failure = nil
		Task {
			let created = await store.create(draft, idempotencyKey: key)
			isSaving = false
			if let created {
				onCreated(created)
				dismiss()
			} else {
				failure = store.actionError ?? "Couldn't create it. Try again."
			}
		}
	}
}
