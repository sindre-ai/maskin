import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The actor's workspaces, the selected one checked. Picking one switches the whole app (the
/// event stream and every store follow `auth.session.workspaceId`) and dismisses.
public struct WorkspaceSwitcher: View {
	private let environment: AppEnvironment
	@Environment(\.dismiss) private var dismiss

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
									"\(workspace.memberCount) \(workspace.memberCount == 1 ? "member" : "members")"
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

#Preview("Workspaces") {
	let env = AppEnvironment.preview()
	WorkspaceSwitcher(environment: env)
		.task { await env.workspaces.refresh() }
}
