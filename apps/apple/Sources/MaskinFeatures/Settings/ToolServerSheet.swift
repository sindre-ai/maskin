import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the Add server form sends: an HTTP MCP server, optionally with a bearer key.
struct ToolServerDraft: Equatable {
	var name = ""
	var url = ""
	var key = ""

	/// "mcp.linear.app" becomes "https://mcp.linear.app". Plain http is refused: the key would
	/// travel in the clear.
	var normalizedURL: URL? {
		var text = url.trimmingCharacters(in: .whitespacesAndNewlines)
		if text.isEmpty { return nil }
		if !text.contains("://") { text = "https://" + text }
		guard let url = URL(string: text), url.scheme == "https", let host = url.host, host.contains(".")
		else { return nil }
		return url
	}

	var isValid: Bool {
		!name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 60 && normalizedURL != nil
	}

	var body: [String: Any]? {
		guard isValid, let url = normalizedURL else { return nil }
		var server: [String: Any] = ["type": "http", "url": url.absoluteString]
		let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
		if !trimmedKey.isEmpty { server["headers"] = ["Authorization": "Bearer \(trimmedKey)"] }
		return ["name": name.trimmingCharacters(in: .whitespacesAndNewlines), "server": server]
	}
}

protocol ToolServersAPI: Sendable { func add(_ body: [String: Any]) async throws }

struct HTTPToolServersSource: ToolServersAPI {
	let http: SettingsHTTP
	func add(_ body: [String: Any]) async throws {
		let reply = try await http.send("POST", "api/custom-mcp-servers", body: body)
		switch reply.status {
		case 200..<300: return
		case 403: throw SettingsError("Only a person in the workspace can add a tool server.")
		case 400, 422: throw SettingsError("The server details were not accepted. Check the address.")
		default: throw SettingsError("Couldn't add the server.")
		}
	}
}

/// Add server (2g): name, address and an optional key. The key is sent once and never shown again.
struct ToolServerSheet: View {
	let api: any ToolServersAPI
	var onAdded: () -> Void = {}
	@Environment(\.dismiss) private var dismiss
	@State private var draft = ToolServerDraft()
	@State private var working = false
	@State private var error: String?

	var body: some View {
		NavigationStack {
			Form {
				Section("Name") {
					TextField("linear-mcp", text: $draft.name).frame(minHeight: MaskinSpace.touchMin)
				}
				Section("URL") {
					TextField("mcp.linear.app", text: $draft.url)
						.font(MaskinTypeface.mono(MaskinFontSize.t14, relativeTo: .body))
						#if os(iOS)
							.textInputAutocapitalization(.never)
							.keyboardType(.URL)
						#endif
						.autocorrectionDisabled()
						.frame(minHeight: MaskinSpace.touchMin)
				}
				Section {
					SecureField("Optional", text: $draft.key).frame(minHeight: MaskinSpace.touchMin)
				} header: {
					Text("Key")
				} footer: {
					Text("Sent as a bearer key. It is stored on the server and not shown again.")
				}
				if let error { Section { FormError(error) } }
			}
			.settingsListStyle()
			.navigationTitle("Add server")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Add") { Task { await submit() } }.disabled(!draft.isValid || working)
				}
			}
		}
		.presentationDetents([.large])
	}

	private func submit() async {
		guard let body = draft.body else { return }
		working = true
		error = nil
		defer { working = false }
		do {
			try await api.add(body)
			onAdded()
			dismiss()
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Couldn't add the server."
		}
	}
}
