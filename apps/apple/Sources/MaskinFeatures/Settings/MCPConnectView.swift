import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Connecting Claude (or any MCP client) to this workspace. The commands embed the signed-in
/// API key, so they are only ever copied (to a local-only, expiring pasteboard entry), never
/// shown.
struct MCPConnectView: View {
	let serverURL: URL
	let workspaceId: String
	let apiKey: @MainActor () -> SecretValue?
	@State private var copiedLabel: String?

	var body: some View {
		List {
			Section {
				LabeledContent("Server", value: serverURL.absoluteString)
					.frame(minHeight: MaskinSpace.touchMin)
			} footer: {
				Text("Maskin speaks MCP over HTTP, so any MCP-capable assistant can read and update this workspace.")
			}
			Section {
				copyRow("Claude Code command", symbol: "terminal") { key in
					"claude mcp add --transport http maskin \(serverURL.absoluteString) --header \"Authorization: Bearer \(key)\" --header \"X-Workspace-Id: \(workspaceId)\""
				}
				copyRow("Claude.ai connector link", symbol: "link") { key in
					var parts = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)
					parts?.queryItems = [
						URLQueryItem(name: "key", value: key),
						URLQueryItem(name: "workspace", value: workspaceId),
					]
					return parts?.url?.absoluteString ?? serverURL.absoluteString
				}
			} header: {
				Text("Copy")
			} footer: {
				Text(
					copiedLabel.map { "\($0) copied. It leaves the clipboard in a minute and includes your API key, so keep it private." }
						?? "Each includes your API key, so keep it private.")
			}
		}
		.settingsListStyle()
		.navigationTitle("Connect Claude")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
	}

	private func copyRow(_ title: String, symbol: String, build: @escaping (String) -> String)
		-> some View
	{
		Button {
			guard let key = apiKey() else { return }
			if SecretPasteboard.copy(build(key.reveal())) { copiedLabel = title }
		} label: {
			SettingsRow(symbol: symbol, title: title)
		}
		.disabled(apiKey() == nil)
	}
}
