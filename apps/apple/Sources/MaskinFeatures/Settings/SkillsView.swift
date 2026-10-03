import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

struct SkillsView: View {
	@State private var store: SkillsStore
	@State private var editing: SkillEditorTarget?
	@State private var pendingDelete: WorkspaceSkill?

	init(store: SkillsStore) { _store = State(initialValue: store) }

	var body: some View {
		List {
			ForEach(store.skills) { skill in
				Button { editing = .existing(skill) } label: { SkillRow(skill: skill) }
					.buttonStyle(.plain)
					.swipeActions(edge: .trailing) {
						Button("Delete", role: .destructive) { pendingDelete = skill }
					}
					.contextMenu {
						Button("Edit", systemImage: "pencil") { editing = .existing(skill) }
						Button("Delete", systemImage: "trash", role: .destructive) {
							pendingDelete = skill
						}
					}
			}
			if let error = store.actionError, editing == nil {
				Section { FormError(error) }
			}
		}
		.settingsListStyle()
		.overlay {
			switch store.phase {
			case .loading: ProgressView()
			case .failed(let message):
				ContentUnavailableView(
					"Couldn't load skills", systemImage: "wifi.exclamationmark",
					description: Text(message))
			case .loaded where store.skills.isEmpty:
				ContentUnavailableView(
					"No skills yet", systemImage: "wand.and.stars",
					description: Text("Add a skill to teach your agents a repeatable way of working."))
			default: EmptyView()
			}
		}
		.navigationTitle("Skills")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.toolbar {
			ToolbarItem(placement: .primaryAction) {
				Button("New skill", systemImage: "plus") { editing = .new }
			}
		}
		.task { await store.load() }
		.refreshable { await store.load() }
		.sheet(item: $editing) { target in SkillEditorView(store: store, target: target) }
		.confirmationDialog(
			pendingDelete.map { "Delete \($0.name)?" } ?? "Delete skill?",
			isPresented: Binding(
				get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
			titleVisibility: .visible, presenting: pendingDelete
		) { skill in
			Button("Delete skill", role: .destructive) { Task { await store.delete(skill) } }
		} message: { _ in
			Text("Agents that use it lose it right away.")
		}
	}
}

enum SkillEditorTarget: Identifiable {
	case new
	case existing(WorkspaceSkill)

	var id: String {
		switch self {
		case .new: "new"
		case .existing(let skill): skill.id
		}
	}
}

/// Create or edit one skill's markdown. The name is fixed once a skill exists.
struct SkillEditorView: View {
	@Environment(\.dismiss) private var dismiss
	let store: SkillsStore
	let target: SkillEditorTarget
	@State private var name = ""
	@State private var content = ""
	@State private var loadError: String?
	@State private var isLoading = false

	private var isNew: Bool {
		if case .new = target { return true }
		return false
	}

	private var canSave: Bool {
		!store.isSaving && !isLoading && loadError == nil
			&& SkillsStore.validate(name: name, content: content, isNew: isNew) == nil
	}

	var body: some View {
		NavigationStack {
			Form {
				Section {
					if isNew {
						TextField("weekly-review", text: $name)
							#if os(iOS)
								.textInputAutocapitalization(.never)
							#endif
							.autocorrectionDisabled()
							.frame(minHeight: MaskinSpace.touchMin)
					} else {
						Text(name).foregroundStyle(MaskinColor.ink)
					}
				} header: {
					Text("Name")
				} footer: {
					if isNew { Text("Lowercase letters, numbers and hyphens.") }
				}
				Section("Instructions") {
					TextEditor(text: $content)
						.font(.system(.callout, design: .monospaced))
						.frame(minHeight: 280)
						.autocorrectionDisabled()
						#if os(iOS)
							.textInputAutocapitalization(.never)
						#endif
				}
				if let message = loadError ?? store.actionError { Section { FormError(message) } }
			}
			.settingsListStyle()
			.navigationTitle(isNew ? "New skill" : "Edit skill")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") {
						Task {
							let ok = isNew
								? await store.create(name: name, content: content)
								: await store.update(name: name, content: content)
							if ok { dismiss() }
						}
					}
					.disabled(!canSave)
				}
			}
			.overlay { if isLoading || store.isSaving { ProgressView() } }
			.task { await prepare() }
		}
		.presentationDetents([.large])
		.interactiveDismissDisabled(store.isSaving)
	}

	private func prepare() async {
		store.dismissError()
		guard case .existing(let skill) = target else { return }
		name = skill.name
		isLoading = true
		defer { isLoading = false }
		do { content = try await store.content(of: skill) }
		catch { loadError = (error as? SettingsError)?.message ?? "Couldn't open that skill." }
	}
}
