import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings › Delete workspace, for the current workspace. Blockers replace the form; otherwise
/// the person types the workspace's name back, then confirms once more.
struct DeleteWorkspaceView: View {
	@Environment(\.dismiss) private var dismiss
	@State private var store: WorkspaceDeletionStore
	@State private var confirming = false

	init(store: WorkspaceDeletionStore) { _store = State(initialValue: store) }

	var body: some View {
		Form {
			switch store.phase {
			case .idle, .loading:
				Section {
					HStack(spacing: MaskinSpace.s8) {
						ProgressView()
						Text("Checking this workspace").foregroundStyle(MaskinColor.ink3)
					}
					.frame(minHeight: MaskinSpace.touchMin)
					.accessibilityElement(children: .combine)
				}
			case .failed(let message):
				Section {
					FormError(message)
					Button("Try again") { Task { await store.load() } }
						.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				}
			case .loaded(let preview):
				Section {
					Text(Self.warning(
						name: preview.workspaceName, otherMembers: preview.otherMembers,
						isLastWorkspace: store.isLastWorkspace))
						.foregroundStyle(MaskinColor.ink)
				}
				if preview.canDelete { confirmation(preview) } else { blockers(preview) }
			}
			if let error = store.error {
				Section { FormError(error) }
			}
		}
		.settingsListStyle()
		.navigationTitle("Delete workspace")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.overlay { if store.isDeleting { ProgressView() } }
		.task { await store.load() }
		.confirmationDialog(
			"Delete \(store.preview?.workspaceName ?? "this workspace") permanently?",
			isPresented: $confirming, titleVisibility: .visible
		) {
			Button("Delete workspace", role: .destructive) {
				Task { if await store.delete() { dismiss() } }
			}
		} message: {
			Text(Self.finalWarning(isLastWorkspace: store.isLastWorkspace))
		}
	}

	private func blockers(_ preview: WorkspaceDeletionPreview) -> some View {
		Section {
			ForEach(preview.blockers) { blocker in
				Label {
					Text(blocker.message).foregroundStyle(MaskinColor.ink)
				} icon: {
					Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(MaskinColor.warning)
				}
				.accessibilityElement(children: .combine)
				.accessibilityLabel("Blocks deletion: \(blocker.message)")
			}
		} header: {
			Text("Before you can delete")
		} footer: {
			Text("Nothing has been deleted.")
		}
	}

	private func confirmation(_ preview: WorkspaceDeletionPreview) -> some View {
		Section {
			TextField(preview.workspaceName, text: $store.typedName)
				.autocorrectionDisabled()
				#if os(iOS)
					.textInputAutocapitalization(.never)
				#endif
				.submitLabel(.done)
				.accessibilityLabel("Type the workspace name to confirm")
			Button("Delete workspace", role: .destructive) { confirming = true }
				.disabled(!store.canConfirm)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
		} header: {
			Text("Confirm")
		} footer: {
			Text("Type “\(preview.workspaceName)” to delete it.")
		}
	}

	static func finalWarning(isLastWorkspace: Bool) -> String {
		let base = "Everything in it is deleted for good. This can't be undone."
		return isLastWorkspace
			? base + " This is your last workspace, so you will have none left. You can then choose to delete your account too."
			: base
	}

	static func warning(name: String, otherMembers: Int, isLastWorkspace: Bool = false) -> String {
		var text = "Deleting “\(name)” permanently removes its objects, files, agents and history."
		switch otherMembers {
		case 0: break
		case 1: text += " 1 other person loses access."
		default: text += " \(otherMembers) other people lose access."
		}
		if isLastWorkspace { text += " It is your last workspace: you will have none left." }
		return text
	}
}
