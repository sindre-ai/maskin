import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Settings > Advanced: Native surfaces, the state previews, About and the danger zone.
///
/// The Preview switches force one screen state (loading, empty or error) on every tab, or the
/// offline banner, so each can be looked at without breaking anything. They are off by default and
/// the tabs read their real data and network state unless one is on.
struct AdvancedPage: View {
	@AppStorage(StatePreview.screenKey) private var screenState = ""
	@AppStorage(StatePreview.offlineKey) private var offline = false
	@Environment(\.openURL) private var openURL
	let environment: AppEnvironment

	var body: some View {
		List {
			Section("Device") {
				NavigationLink(value: SettingsRoute.nativeSurfaces) {
					SettingsRow(
						symbol: "iphone.gen3", title: "Native surfaces",
						detail: nil)
				}
			}
			Section {
				ForEach(StatePreview.allCases, id: \.self) { preview in
					Toggle(preview.title, isOn: binding(for: preview))
						.frame(minHeight: MaskinSpace.touchMin)
				}
				Toggle(isOn: $offline) {
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						Text("Show offline banner")
						Text("Shows how the app looks without a connection")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
				}
				.frame(minHeight: MaskinSpace.touchMin)
			} header: {
				Text("Preview")
			} footer: {
				Text("Off, every tab shows its real data. On, it shows the state you pick.")
			}
			Section("About") {
				if let url = SettingsServices(environment: environment).webSettingsURL {
					Button("Privacy & data") { openURL(url) }
				}
				if let url = AuthConfig.current.privacyURL { Button("Privacy policy") { openURL(url) } }
				if let url = AuthConfig.current.termsURL { Button("Terms of Service") { openURL(url) } }
				LabeledContent("Version", value: SettingsScreen.versionString)
			}
			// Both irreversible actions live here, in the danger colour, each on its own row.
			Section("Danger zone") {
				if environment.workspaceId != nil {
					NavigationLink(value: SettingsRoute.deleteWorkspace) {
						SettingsRow(symbol: "trash", title: "Delete workspace", destructive: true)
					}
				}
				NavigationLink(value: SettingsRoute.deleteAccount) {
					SettingsRow(symbol: "person.crop.circle.badge.minus", title: "Delete account", destructive: true)
				}
			}
		}
		.settingsListStyle()
		.navigationTitle("Advanced")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
	}

	/// One preview at a time: switching one on switches the others off.
	private func binding(for preview: StatePreview) -> Binding<Bool> {
		Binding(
			get: { screenState == preview.rawValue },
			set: { screenState = $0 ? preview.rawValue : "" })
	}
}
