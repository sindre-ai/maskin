import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Keys & MCP (2D, tidied per `7-Chat.md` §10). MCP SERVER: the server URL (tap to copy), how
/// many tools it exposes, how clients sign in, the ready-made connect commands, and the clients
/// connected (tap to disconnect). API KEYS: the signed-in person's own key, with a new key behind
/// it. The API has one key per person and no listing, so that is the one row.
///
/// The connect commands embed the API key, so they are only ever copied (to a local-only,
/// expiring pasteboard entry), never shown. The tool count, the client list and the revoke call
/// are stubbed in `APISettingsSource` until the API offers them; the page says "Not available
/// yet" rather than pretending.
struct KeysPage: View {
	@State private var store: APIKeyStore
	@State private var mcp: MCPStore
	let workspaceId: String
	let apiKey: @MainActor () -> SecretValue?
	@State private var confirming = false
	@State private var copied = false
	@State private var copiedLabel: String?
	@State private var pendingDisconnect: MCPClient?
	@Environment(\.scenePhase) private var scenePhase

	init(store: APIKeyStore, mcp: MCPStore, workspaceId: String, apiKey: @escaping @MainActor () -> SecretValue?) {
		_store = State(initialValue: store)
		_mcp = State(initialValue: mcp)
		self.workspaceId = workspaceId
		self.apiKey = apiKey
	}

	var body: some View {
		WorkspacePage(title: "Keys & MCP") {
			PageGroupLabel(text: "MCP server")
			PageCard(rows: serverRows + clientRows)
			PageFootnote(text: serverFootnote)
			PageGroupLabel(text: "API keys")
			PageCard(rows: [
				PageRowModel(
					id: "own", title: "Your API key",
					subtitle: apiKey()?.masked ?? "Not signed in", subtitleIsMono: true,
					accessory: .state(WorkspacePageState.activeKey))
			])
			if let text = store.displayText {
				SecretKeyCard(
					text: text, isRevealed: store.isRevealed,
					onToggle: { store.setRevealed(!store.isRevealed) },
					onCopy: { copy() })
				PageFootnote(
					text: copied
						? "Copied. It leaves the clipboard in a minute."
						: "Copy it now. It will not be shown again.")
			}
			if let error = store.error ?? mcp.actionError { FormError(error) }
			PageFootnote(
				text: store.canRegenerate || store.phase == .regenerating
					? "A new key replaces this one. Anything using the old key stops working."
					: "Making a new key is not available in this build yet.")
			Button(store.phase == .regenerating ? "Making a key" : "New key") { confirming = true }
				.buttonStyle(.primaryAction)
				.disabled(!store.canRegenerate)
			PageFootnote(text: Self.footer)
		}
		.task { await mcp.load() }
		.refreshable { await mcp.load() }
		.onDisappear { store.clear() }
		.onChange(of: scenePhase) { _, phase in
			if phase != .active { store.concealForScene(isBackground: phase == .background) }
		}
		.confirmationDialog("Revoke key?", isPresented: $confirming, titleVisibility: .visible) {
			Button("Revoke and make a new key", role: .destructive) {
				copied = false
				Task { await store.regenerate() }
			}
		} message: {
			Text(
				"Anything using it stops working. Other devices are signed out and must use the new key.")
		}
		.confirmationDialog(
			pendingDisconnect.map { "Disconnect \($0.name)?" } ?? "Disconnect?",
			isPresented: Binding(
				get: { pendingDisconnect != nil }, set: { if !$0 { pendingDisconnect = nil } }),
			titleVisibility: .visible, presenting: pendingDisconnect
		) { client in
			Button("Disconnect", role: .destructive) { Task { await mcp.disconnect(client) } }
		} message: { client in
			Text("\(client.name) loses access to this workspace right away. It can connect again with a key.")
		}
	}

	static let footer = "MCP lets Claude, Cursor and other AI tools use this workspace with your permissions."

	// MARK: MCP SERVER rows

	private var serverRows: [PageRowModel] {
		[
			PageRowModel(
				id: "url", title: "Server URL", subtitle: mcp.serverURL.absoluteString, subtitleIsMono: true,
				accessory: .state(PageState(copiedLabel == "Server URL" ? "Copied" : "Copy", .plain)),
				action: {
					if PlainPasteboard.copy(mcp.serverURL.absoluteString) { copiedLabel = "Server URL" }
				}),
			PageRowModel(
				id: "tools", title: "Tools exposed", subtitle: "Objects, flows, decisions, search, chat",
				accessory: .state(
					mcp.toolCountText.map { PageState($0, .plain) } ?? PageState("Not available yet", .muted))),
			PageRowModel(id: "auth", title: "Auth", subtitle: mcp.authLabel),
			copyRow("Claude Code command") { key in
				"claude mcp add --transport http maskin \(mcp.serverURL.absoluteString) --header \"Authorization: Bearer \(key)\" --header \"X-Workspace-Id: \(workspaceId)\""
			},
			copyRow("Claude.ai connector link") { key in
				var parts = URLComponents(url: mcp.serverURL, resolvingAgainstBaseURL: false)
				parts?.queryItems = [
					URLQueryItem(name: "key", value: key),
					URLQueryItem(name: "workspace", value: workspaceId),
				]
				return parts?.url?.absoluteString ?? mcp.serverURL.absoluteString
			},
		]
	}

	/// Connected clients, or one quiet line saying the server does not list them yet.
	private var clientRows: [PageRowModel] {
		var rows: [PageRowModel] = []
		switch mcp.clientsPhase {
		case .idle, .loading:
			if mcp.clients.isEmpty { rows.append(PageRowModel(id: "clients", title: "Connected clients", subtitle: "Loading")) }
		case .unavailable(let message):
			rows.append(
				PageRowModel(
					id: "clients", title: "Connected clients", subtitle: message,
					accessory: .state(PageState("None listed", .muted))))
		case .loaded:
			if mcp.clients.isEmpty {
				rows.append(
					PageRowModel(
						id: "clients", title: "Connected clients", subtitle: "Nothing is connected yet",
						accessory: .state(PageState("0", .muted))))
			}
		}
		for client in mcp.clients {
			rows.append(
				PageRowModel(
					id: "client-\(client.id)", title: client.name,
					subtitle: WorkspacePageState.mcpClientSubtitle(client),
					accessory: .state(
						mcp.busyIDs.contains(client.id)
							? PageState("Disconnecting", .muted) : WorkspacePageState.mcpClientConnected),
					action: mcp.canManage ? { pendingDisconnect = client } : nil))
		}
		return rows
	}

	private var serverFootnote: String {
		guard let copiedLabel else { return "The commands include your API key, so keep them private." }
		return copiedLabel == "Server URL"
			? "Server URL copied. Paste it into your client's MCP settings."
			: "\(copiedLabel) copied. It leaves the clipboard in a minute and includes your API key, so keep it private."
	}

	private func copyRow(_ title: String, build: @escaping (String) -> String) -> PageRowModel {
		PageRowModel(
			id: title, title: title, subtitle: "Includes your API key",
			accessory: .state(PageState(copiedLabel == title ? "Copied" : "Copy", apiKey() == nil ? .muted : .plain)),
			action: apiKey() == nil
				? nil
				: {
					guard let key = apiKey() else { return }
					if SecretPasteboard.copy(build(key.reveal())) { copiedLabel = title }
				})
	}

	private func copy() {
		guard let key = store.newKey else { return }
		copied = SecretPasteboard.copy(key.reveal())
	}
}
