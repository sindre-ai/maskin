import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Signed in, but in no workspace (the last one was deleted, or the person was removed from all
/// of them). The app has nothing to show, so this screen offers a way out: create a workspace
/// (the primary action), or, secondary, delete the account or sign out.
///
/// Right after the person deletes their last workspace it also asks "Delete your account too?".
struct NoWorkspacesView: View {
	let environment: AppEnvironment
	let runtime: AppRuntime
	@State private var showDeleteAccount = false
	@State private var creation: FirstWorkspaceStore
	/// Held so the monitor outlives `init`; the store reads `isOnline` from it.
	@State private var network: NWPathNetworkMonitor
	@FocusState private var nameFocused: Bool

	init(environment: AppEnvironment, runtime: AppRuntime) {
		self.environment = environment
		self.runtime = runtime
		let monitor = NWPathNetworkMonitor()
		_network = State(initialValue: monitor)
		let workspaces = environment.workspaces
		let api = APISettingsSource(client: environment.client, workspaceID: "")
		_creation = State(
			initialValue: FirstWorkspaceStore(
				api: api, isOnline: { monitor.isOnline },
				didCreate: { created in
					workspaces.created(id: created.id, name: created.name)
					await workspaces.refresh()
				}))
	}

	private static let columnWidth: CGFloat = 440

	var body: some View {
		let workspaces = environment.workspaces
		ScrollView {
			EmptyState(
				symbol: "tray", title: "No workspaces",
				message:
					"You are not in any workspace yet. Create one to get started, or delete your account or sign out.",
				style: .circled
			) {
				VStack(spacing: MaskinSpace.s5) {
					AuthField(
						label: "Workspace name", problem: creation.error, isFocused: nameFocused
					) {
						TextField("Workspace name", text: $creation.name)
							.focused($nameFocused)
							.submitLabel(.done)
							.disabled(creation.isCreating)
							.onSubmit { Task { await creation.create() } }
							.onChange(of: creation.name) { creation.dismissError() }
					}
					Button {
						Task { await creation.create() }
					} label: {
						if creation.isCreating {
							ProgressView()
						} else {
							Text("Create workspace")
						}
					}
					.buttonStyle(.primaryAction)
					.disabled(!creation.canCreate)
					.accessibilityLabel(creation.isCreating ? "Creating workspace" : "Create workspace")
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
			Text(
				"Your account, profile and keys are deleted. You will confirm with your password first. Not now keeps you here, where you can create a new workspace."
			)
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
