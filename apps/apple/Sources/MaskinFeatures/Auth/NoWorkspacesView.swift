import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Signed in, but in no workspace (the last one was deleted, or the person was removed from all
/// of them). The app has nothing to show, so this screen says so and offers the only two things
/// that make sense here: delete the account, or sign out. Creating a workspace is not offered.
///
/// Right after the person deletes their last workspace it also asks "Delete your account too?".
struct NoWorkspacesView: View {
	let environment: AppEnvironment
	let runtime: AppRuntime
	@State private var showDeleteAccount = false

	private static let columnWidth: CGFloat = 440

	var body: some View {
		let workspaces = environment.workspaces
		ScrollView {
			EmptyState(
				symbol: "tray", title: "No workspaces",
				message:
					"You are not in any workspace, so there is nothing to show. You can delete your account or sign out.",
				style: .circled
			) {
				VStack(spacing: MaskinSpace.s5) {
					Button("Delete account") { showDeleteAccount = true }
						.buttonStyle(.secondaryAction)
					Button("Sign out") { Task { await runtime.signOut() } }
						.buttonStyle(.secondaryAction)
				}
			}
			.frame(maxWidth: Self.columnWidth)
			.frame(maxWidth: .infinity)
		}
		.ambientBackground()
		.alert(
			Self.offerTitle,
			isPresented: Binding(
				get: { workspaces.offersAccountDeletion },
				set: { if !$0 { workspaces.dismissAccountDeletionOffer() } })
		) {
			Button("Delete account") { showDeleteAccount = true }
			Button("Not now", role: .cancel) {}
		} message: {
			Text("Your account, profile and keys are deleted. You will confirm with your password first.")
		}
		.sheet(isPresented: $showDeleteAccount) {
			NavigationStack {
				DeleteAccountView(
					store: SettingsServices(environment: environment).accountDeletionStore {
						[runtime] in await runtime.signOut()
					}
				)
				.toolbar {
					ToolbarItem(placement: .cancellationAction) {
						Button("Cancel") { showDeleteAccount = false }
					}
				}
			}
		}
	}

	static let offerTitle = "You have no workspaces left. Delete your account too?"
}
