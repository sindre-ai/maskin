import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Name + description fields shared by the new-loop and edit-loop sheets.
private struct LoopFields: View {
	@Binding var name: String
	@Binding var description: String
	@FocusState private var focused: Bool

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s9) {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					MonoLabel("Name")
					TextField("Weekly customer feedback triage", text: $name, axis: .vertical)
						.maskinText(.title)
						.foregroundStyle(MaskinColor.ink)
						.lineLimit(1...3)
						.focused($focused)
				}
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					MonoLabel("What should it do?")
					TextField(
						"Have a triage agent review every new feedback item when it comes in, and ask me before anything ships.",
						text: $description, axis: .vertical
					)
					.maskinText(.body)
					.foregroundStyle(MaskinColor.ink2)
					.lineLimit(4...16)
					.padding(MaskinSpace.s8)
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
				}
			}
			.padding(MaskinSpace.s9)
			.frame(maxWidth: 640, alignment: .leading)
			.frame(maxWidth: .infinity)
		}
		.background(MaskinSurface.grouped)
		.scrollDismissesKeyboard(.interactively)
		.onAppear { focused = name.isEmpty }
	}
}

/// Create a loop: a name and what it should do. Agents and triggers are added from the web or by
/// installing from the marketplace.
struct NewLoopSheet: View {
	let store: LoopsStore
	let onCreated: (String) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var name = ""
	@State private var content = ""
	@State private var isCreating = false

	private var canCreate: Bool {
		!name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isCreating
	}

	var body: some View {
		NavigationStack {
			VStack(spacing: 0) {
				if let notice = store.notice {
					FormError(notice).padding(.horizontal, MaskinSpace.s9).onTapGesture { store.notice = nil }
				}
				LoopFields(name: $name, description: $content)
			}
			.navigationTitle("New loop")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Create") { Task { await create() } }.disabled(!canCreate)
				}
			}
			.overlay { if isCreating { ProgressView() } }
			.onAppear { store.notice = nil }
		}
		.presentationDetents([.large])
	}

	private func create() async {
		isCreating = true
		defer { isCreating = false }
		if let id = await store.create(name: name, description: content) {
			onCreated(id)
			dismiss()
		}
	}
}

/// Rename a loop and rewrite its description.
struct EditLoopSheet: View {
	let store: LoopDetailStore

	@Environment(\.dismiss) private var dismiss
	@State private var name: String
	@State private var content: String
	@State private var isSaving = false

	init(store: LoopDetailStore) {
		self.store = store
		_name = State(initialValue: store.loop.name ?? "")
		_content = State(initialValue: store.loop.content ?? "")
	}

	var body: some View {
		NavigationStack {
			VStack(spacing: 0) {
				if let notice = store.notice {
					FormError(notice).padding(.horizontal, MaskinSpace.s9).onTapGesture { store.notice = nil }
				}
				LoopFields(name: $name, description: $content)
			}
			.navigationTitle("Edit loop")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") { Task { await save() } }
						.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
				}
			}
			.onAppear { store.notice = nil }
		}
		.presentationDetents([.large])
	}

	private func save() async {
		isSaving = true
		defer { isSaving = false }
		if await store.save(name: name, content: content) { dismiss() }
	}
}
