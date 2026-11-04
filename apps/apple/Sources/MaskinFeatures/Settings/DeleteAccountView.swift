import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings › Delete account (App Review 5.1.1(v)). Preview first: what blocks it, which
/// workspaces the person leaves, which go with the account. Then password, then a last
/// destructive confirmation that states what is lost.
struct DeleteAccountView: View {
	@State private var store: AccountDeletionStore
	@State private var confirming = false

	init(store: AccountDeletionStore) { _store = State(initialValue: store) }

	var body: some View {
		Form {
			switch store.phase {
			case .idle, .loading:
				Section {
					HStack(spacing: MaskinSpace.s8) {
						ProgressView()
						Text("Checking your account").foregroundStyle(MaskinColor.ink3)
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
				intro
				if !preview.canDelete { blockers(preview) }
				leaving(preview)
				if preview.canDelete { confirmation }
			}
			if let error = store.error {
				Section { FormError(error) }
			}
		}
		.settingsListStyle()
		.navigationTitle("Delete account")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.overlay { if store.isDeleting { ProgressView() } }
		.task { await store.load() }
		.onChange(of: store.deleteSoleWorkspaces) { Task { await store.load() } }
		.confirmationDialog(
			"Delete your account permanently?", isPresented: $confirming, titleVisibility: .visible
		) {
			Button("Delete my account", role: .destructive) { Task { await store.delete() } }
		} message: {
			Text(Self.finalWarning(deletesWorkspaces: store.deleteSoleWorkspaces, preview: store.preview))
		}
	}

	private var intro: some View {
		Section {
			Text(
				"Deleting your account is permanent. You are signed out everywhere, your profile and keys are removed, and you lose access to every workspace you are in."
			)
			.foregroundStyle(MaskinColor.ink)
		}
	}

	@ViewBuilder
	private func blockers(_ preview: AccountDeletionPreview) -> some View {
		Section {
			ForEach(preview.blockers) { blocker in
				Label {
					Text(blocker.guidance).foregroundStyle(MaskinColor.ink)
				} icon: {
					Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(MaskinColor.warning)
				}
				.accessibilityElement(children: .combine)
				.accessibilityLabel("Blocks deletion: \(blocker.guidance)")
			}
		} header: {
			Text("Before you can delete")
		} footer: {
			Text("Sort these out, then come back. Nothing has been deleted.")
		}
	}

	@ViewBuilder
	private func leaving(_ preview: AccountDeletionPreview) -> some View {
		if !preview.sharedWorkspaces.isEmpty {
			Section {
				ForEach(preview.sharedWorkspaces) { workspace in
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text(workspace.workspaceName).foregroundStyle(MaskinColor.ink)
						Text(Self.othersStay(workspace.otherMembers))
							.font(.footnote).foregroundStyle(MaskinColor.ink4)
					}
					.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
					.accessibilityElement(children: .combine)
				}
			} header: {
				Text("You will leave")
			} footer: {
				Text("These keep going without you.")
			}
		}
		if !preview.soleWorkspaces.isEmpty {
			Section {
				ForEach(preview.soleWorkspaces) { workspace in
					Text(workspace.workspaceName).foregroundStyle(MaskinColor.ink)
						.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
						.accessibilityLabel("\(workspace.workspaceName), only you are in it")
				}
				Toggle("Also delete these workspaces", isOn: $store.deleteSoleWorkspaces)
					.frame(minHeight: MaskinSpace.touchMin)
			} header: {
				Text("Only you are in these")
			} footer: {
				Text(
					store.deleteSoleWorkspaces
						? "They and everything in them are deleted with your account."
						: "They are kept, but no one will be able to open them.")
			}
		}
	}

	private var confirmation: some View {
		Section {
			SecureField("Password", text: $store.password)
				.textContentType(.password)
				.submitLabel(.done)
				.accessibilityLabel("Your password")
			Button("Delete account", role: .destructive) { confirming = true }
				.disabled(!store.canConfirm)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
		} header: {
			Text("Confirm")
		} footer: {
			Text("Enter your password to delete your account. This can't be undone.")
		}
	}

	static func othersStay(_ count: Int) -> String {
		switch count {
		case 0: "No one else"
		case 1: "1 other person stays"
		default: "\(count) other people stay"
		}
	}

	static func finalWarning(deletesWorkspaces: Bool, preview: AccountDeletionPreview?) -> String {
		var text = "Your account, profile and keys are deleted and you are signed out. This can't be undone."
		if deletesWorkspaces, let sole = preview?.soleWorkspaces, !sole.isEmpty {
			text += " "
			text += sole.count == 1
				? "“\(sole[0].workspaceName)” and everything in it are deleted too."
				: "\(sole.count) workspaces and everything in them are deleted too."
		}
		return text
	}
}
