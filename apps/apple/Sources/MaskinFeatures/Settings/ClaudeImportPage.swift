import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

// MARK: Store

/// Where the workspace's model access comes from: a Claude subscription, or API credits.
struct ClaudeConnection: Equatable, Sendable {
	var connected: Bool
	var valid: Bool
	var plan: String?
	var expiresAt: Date?
	var backups: Int

	static let none = ClaudeConnection(connected: false, valid: false, plan: nil, expiresAt: nil, backups: 0)

	/// "max" -> "Claude Max".
	var planLabel: String? {
		guard let plan, !plan.isEmpty else { return nil }
		return "Claude \(plan.prefix(1).uppercased())\(plan.dropFirst())"
	}

	static func parse(_ json: Any?) -> ClaudeConnection? {
		guard let root = json as? [String: Any] else { return nil }
		let slots = root["slots"] as? [String: Any] ?? [:]
		let expires = (root["expires_at"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) }
		return ClaudeConnection(
			connected: root["connected"] as? Bool ?? false, valid: root["valid"] as? Bool ?? false,
			plan: root["subscription_type"] as? String, expiresAt: expires,
			backups: max(0, slots.count - ((root["connected"] as? Bool ?? false) ? 1 : 0)))
	}
}

protocol ClaudeConnectionAPI: Sendable { func status() async throws -> ClaudeConnection }

struct HTTPClaudeConnectionSource: ClaudeConnectionAPI {
	let http: SettingsHTTP
	func status() async throws -> ClaudeConnection {
		let reply = try await http.send("GET", "api/claude-oauth/status")
		guard reply.ok, let parsed = ClaudeConnection.parse(reply.json) else {
			throw SettingsError("Couldn't check your Claude connection.")
		}
		return parsed
	}
}

@MainActor
@Observable
final class ClaudeConnectionStore {
	enum Phase: Equatable { case idle, loading, loaded, failed(String) }
	private(set) var connection = ClaudeConnection.none
	private(set) var phase: Phase = .idle
	@ObservationIgnored private let api: any ClaudeConnectionAPI
	init(api: any ClaudeConnectionAPI) { self.api = api }

	func load() async {
		if phase != .loaded { phase = .loading }
		do {
			connection = try await api.status()
			phase = .loaded
		} catch {
			if phase != .loaded { phase = .failed((error as? SettingsError)?.message ?? "Couldn't check.") }
		}
	}
}

// MARK: View

/// Import from Claude (2j): whether agents run on a Claude subscription. The sign-in that hands
/// over the subscription happens on the web (the app never sees Claude credentials), so this
/// page shows the state and sends the person there to connect or change it.
struct ClaudeImportPage: View {
	@State private var store: ClaudeConnectionStore
	let webURL: URL?
	let canManage: Bool
	@Environment(\.openURL) private var openURL

	init(store: ClaudeConnectionStore, webURL: URL?, canManage: Bool) {
		_store = State(initialValue: store)
		self.webURL = webURL
		self.canManage = canManage
	}

	var body: some View {
		let c = store.connection
		WorkspacePage(title: "Import from Claude") {
			PageGroupLabel(text: "Use your Claude subscription")
			switch store.phase {
			case .failed(let message): PageStatus(text: message)
			case .idle, .loading: PageStatus(text: "Checking your connection")
			case .loaded:
				PageCard(rows: [
					PageRowModel(
						id: "account", title: c.connected ? (c.planLabel ?? "Claude subscription") : "Not connected",
						subtitle: c.connected
							? (c.valid ? "Agents use your plan instead of API credits" : "Sign in again to keep agents running")
							: "Agents use API credits",
						accessory: .state(
							c.connected ? (c.valid ? PageState("Connected", .active) : PageState("Reconnect", .notice)) : PageState("Off", .muted)))
				])
				if c.backups > 0 {
					PageCard(rows: [
						PageRowModel(
							id: "backups", title: "Backup accounts",
							subtitle: "Used if the first one runs out of room",
							accessory: .state(PageState("\(c.backups)", .plain)))
					])
				}
			}
			PageFootnote(
				text: "Usage counts against your Claude limits. Maskin never sees your password. Signing in happens on the web.")
			if canManage, let webURL {
				Button(store.connection.connected ? "Change on web" : "Connect on web") { openURL(webURL) }
					.buttonStyle(.primaryAction)
			} else if !canManage {
				PageFootnote(text: "Only owners and admins can change this.")
			}
		}
		.task { await store.load() }
		.refreshable { await store.load() }
	}
}
