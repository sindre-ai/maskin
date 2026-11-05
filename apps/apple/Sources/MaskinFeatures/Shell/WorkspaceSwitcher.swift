import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The actor's workspaces, the selected one checked. Picking one switches the whole app (the
/// event stream and every store follow `auth.session.workspaceId`) and dismisses.
public struct WorkspaceSwitcher: View {
	private let environment: AppEnvironment
	@Environment(\.dismiss) private var dismiss
	@Environment(\.openURL) private var openURL
	@State private var showCreate = false
	@State private var showJoin = false
	@State private var inviteText = ""
	@State private var inviteProblem = false

	public init(environment: AppEnvironment) { self.environment = environment }

	public var body: some View {
		let store = environment.workspaces
		NavigationStack {
			List {
				ForEach(store.workspaces) { workspace in
					Button {
						store.select(workspace.id)
						dismiss()
					} label: {
						HStack(spacing: MaskinSpace.s8) {
							MaskinLogoTile(size: MaskinSpace.s14)
							VStack(alignment: .leading, spacing: MaskinSpace.s1) {
								Text(workspace.name).foregroundStyle(MaskinColor.ink)
								Text(
									"\(MemberRole(serverValue: workspace.role).label) \u{00B7} \(workspace.memberCount) \(workspace.memberCount == 1 ? "member" : "members")"
								)
								.font(.footnote)
								.foregroundStyle(MaskinColor.ink4)
							}
							Spacer()
							if workspace.id == store.selectedID {
								Image(systemName: "checkmark").foregroundStyle(MaskinColor.ink)
							}
						}
						.frame(minHeight: MaskinSpace.touchMin)
					}
					.accessibilityAddTraits(workspace.id == store.selectedID ? .isSelected : [])
				}
				Section {
					Button {
						showCreate = true
					} label: {
						Label("Create workspace", systemImage: "plus")
							.foregroundStyle(MaskinColor.ink)
							.frame(minHeight: MaskinSpace.touchMin)
					}
					Button {
						inviteText = ""
						inviteProblem = false
						showJoin = true
					} label: {
						Label("Join with invitation", systemImage: "envelope")
							.foregroundStyle(MaskinColor.ink)
							.frame(minHeight: MaskinSpace.touchMin)
					}
				}
			}
			.sheet(isPresented: $showCreate) {
				CreateWorkspaceSheet(environment: environment) {
					showCreate = false
					dismiss()
				}
			}
			.alert("Join with invitation", isPresented: $showJoin) {
				TextField("Paste the invitation link", text: $inviteText)
					#if os(iOS)
						.textInputAutocapitalization(.never)
						.keyboardType(.URL)
					#endif
					.autocorrectionDisabled()
				Button("Open") { openInvite() }
				Button("Cancel", role: .cancel) {}
			} message: {
				Text(inviteProblem ? "That isn't a Maskin invitation link. Check it and try again." : "Paste the link you were sent.")
			}
			.overlay {
				switch store.phase {
				case .loading where store.workspaces.isEmpty:
					ProgressView()
				case .failed(let message) where store.workspaces.isEmpty:
					ContentUnavailableView(
						"Couldn't load workspaces", systemImage: "wifi.exclamationmark",
						description: Text(message))
				default:
					EmptyView()
				}
			}
			.navigationTitle("Workspaces")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
			}
			.refreshable { await store.refresh() }
		}
	}
}

extension WorkspaceSwitcher {
	/// Hands a pasted invitation link to the app's invite flow, which owns accepting it. Anything
	/// that is not an invitation link asks again.
	fileprivate func openInvite() {
		let text = inviteText.trimmingCharacters(in: .whitespacesAndNewlines)
		guard let url = URL(string: text), let link = InviteLink(url: url) else {
			inviteProblem = true
			showJoin = true
			return
		}
		var c = URLComponents()
		c.scheme = DeepLink.scheme
		c.host = "invite"
		c.queryItems = [URLQueryItem(name: "token", value: link.token)]
		if let opened = c.url { openURL(opened) }
		dismiss()
	}
}

/// A name field and Create: the same call the no-workspaces screen makes, from the switcher.
private struct CreateWorkspaceSheet: View {
	let environment: AppEnvironment
	let created: () -> Void
	@State private var creation: FirstWorkspaceStore
	@State private var network: NWPathNetworkMonitor
	@FocusState private var nameFocused: Bool
	@Environment(\.dismiss) private var dismiss

	init(environment: AppEnvironment, created: @escaping () -> Void) {
		self.environment = environment
		self.created = created
		let monitor = NWPathNetworkMonitor()
		_network = State(initialValue: monitor)
		let workspaces = environment.workspaces
		_creation = State(
			initialValue: FirstWorkspaceStore(
				api: APISettingsSource(client: environment.client, workspaceID: ""),
				isOnline: { monitor.isOnline },
				didCreate: { made in
					workspaces.created(id: made.id, name: made.name)
					await workspaces.refresh()
				}))
	}

	var body: some View {
		NavigationStack {
			VStack(spacing: MaskinSpace.s7) {
				AuthField(label: "Workspace name", problem: creation.error, isFocused: nameFocused) {
					TextField("Workspace name", text: $creation.name)
						.focused($nameFocused)
						.submitLabel(.done)
						.disabled(creation.isCreating)
						.onSubmit { create() }
						.onChange(of: creation.name) { creation.dismissError() }
				}
				Button {
					create()
				} label: {
					if creation.isCreating { ProgressView() } else { Text("Create workspace") }
				}
				.buttonStyle(.primaryAction)
				.disabled(!creation.canCreate)
				Spacer(minLength: 0)
			}
			.padding(MaskinSpace.s9)
			.ambientBackground()
			.navigationTitle("New workspace")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
			}
			.task { nameFocused = true }
		}
		.presentationDetents([.medium])
	}

	private func create() {
		Task { if await creation.create() { created() } }
	}
}

#Preview("Workspaces") {
	let env = AppEnvironment.preview()
	WorkspaceSwitcher(environment: env)
		.task { await env.workspaces.refresh() }
}
