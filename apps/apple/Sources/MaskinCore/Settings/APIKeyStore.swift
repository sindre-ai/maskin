import Foundation
import Observation

/// Regenerating the signed-in actor's API key.
///
/// The old key stops working the moment the server answers, which signs out every other device
/// and any MCP client using it. This device survives only because the new key is handed to
/// `adopt` (the `AuthSession`) before anything else awaits.
///
/// The new key is shown once, masked until the person asks to reveal or copy it, and dropped by
/// `clear()` (the view calls it on disappear). It lives in memory only: nothing here persists,
/// logs or prints it.
@MainActor
@Observable
public final class APIKeyStore {
	public enum Phase: Equatable, Sendable {
		case idle, regenerating
		/// The server rotated the key but this device could not store the new one. The person
		/// must sign in again; the key is still shown so it isn't lost.
		case adoptionFailed
		case done
	}

	public private(set) var phase: Phase = .idle
	public private(set) var newKey: SecretValue?
	public private(set) var error: String?
	public private(set) var isRevealed = false

	@ObservationIgnored private let api: any APIKeysAPI
	@ObservationIgnored private let actorId: String
	@ObservationIgnored private let adopt: (@MainActor (String) throws -> Void)?
	/// Called right before the rotation request, so the session ignores the 401s the rotation
	/// itself causes; `didFailRotation` ends that on any failure before the key is adopted.
	@ObservationIgnored private let willRotate: @MainActor () -> Void
	@ObservationIgnored private let didFailRotation: @MainActor () -> Void

	/// `adopt == nil` means this build cannot store a rotated key, so regenerating is disabled
	/// rather than signing the device out.
	public init(
		api: any APIKeysAPI, actorId: String, adopt: (@MainActor (String) throws -> Void)?,
		willRotate: @escaping @MainActor () -> Void = {},
		didFailRotation: @escaping @MainActor () -> Void = {}
	) {
		self.willRotate = willRotate
		self.didFailRotation = didFailRotation
		self.api = api
		self.actorId = actorId
		self.adopt = adopt
	}

	public var canRegenerate: Bool { adopt != nil && phase != .regenerating }

	public func regenerate() async {
		guard let adopt, phase != .regenerating else { return }
		phase = .regenerating
		error = nil
		newKey = nil
		isRevealed = false
		let key: SecretValue
		willRotate()
		do {
			key = try await api.regenerate(actorId: actorId)
		} catch {
			didFailRotation()
			phase = .idle
			self.error = (error as? SettingsError)?.message ?? "Couldn't regenerate the key."
			return
		}
		newKey = key
		do {
			// Synchronous and immediately after the response: nothing may await in between.
			try adopt(key.reveal())
			phase = .done
		} catch {
			didFailRotation()
			phase = .adoptionFailed
			self.error = "The key was regenerated but couldn't be saved on this device. Sign in again."
		}
	}

	public func setRevealed(_ revealed: Bool) { isRevealed = revealed && newKey != nil }

	/// The text to show: masked unless revealed.
	public var displayText: String? {
		guard let newKey else { return nil }
		return isRevealed ? newKey.reveal() : newKey.masked
	}

	/// The app left the foreground: always mask the key (app switcher snapshots, screenshots);
	/// once it is fully backgrounded, drop it from memory too.
	public func concealForScene(isBackground: Bool) {
		isRevealed = false
		if isBackground { clear() }
	}

	/// Drop the key from memory (view disappears, sheet closes).
	public func clear() {
		newKey = nil
		isRevealed = false
		if phase == .done { phase = .idle }
	}

	public func dismissError() { error = nil }
}

/// The Keys & MCP page's view of the workspace MCP server: its URL (derived, always known), what
/// it exposes, how clients sign in, and which clients are connected. Disconnecting a client is
/// optimistic and rolls back when the server refuses.
///
/// The listing and revoke calls are stubbed in `APISettingsSource` until the API offers them; a
/// stubbed call surfaces as `clientsPhase == .unavailable`, which the page states plainly.
@MainActor
@Observable
public final class MCPStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		/// The server does not list this yet (or could not): the message says which.
		case unavailable(String)
	}

	public let serverURL: URL
	public private(set) var info: MCPServerInfo?
	public private(set) var clients: [MCPClient] = []
	public private(set) var clientsPhase: Phase = .idle
	public private(set) var actionError: String?
	public private(set) var busyIDs: Set<String> = []
	/// Only managers disconnect clients.
	public let canManage: Bool

	@ObservationIgnored private let api: any MCPAPI

	public init(api: any MCPAPI, serverURL: URL, currentRole: MemberRole) {
		self.api = api
		self.serverURL = serverURL
		self.canManage = currentRole.canManage
	}

	/// "24", or nil when the server does not say how many tools it exposes.
	public var toolCountText: String? { info?.toolCount.map(String.init) }

	/// How a client gets in. A bearer API key always works; OAuth only when the server says so.
	public var authLabel: String {
		info?.supportsOAuth == true
			? "OAuth sign-in, or your API key as a bearer token"
			: "Your API key as a bearer token"
	}

	public func load() async {
		if clients.isEmpty { clientsPhase = .loading }
		async let infoResult: MCPServerInfo? = try? api.mcpServerInfo()
		do {
			let list = try await api.mcpClients()
			clients = list.sorted { ($0.lastCallAt ?? .distantPast) > ($1.lastCallAt ?? .distantPast) }
			clientsPhase = .loaded
		} catch {
			let message = (error as? SettingsError)?.message ?? "Couldn't load connected clients."
			if clients.isEmpty { clientsPhase = .unavailable(message) } else { actionError = message }
		}
		info = await infoResult
	}

	@discardableResult
	public func disconnect(_ client: MCPClient) async -> Bool {
		guard canManage, !busyIDs.contains(client.id) else { return false }
		let previous = clients
		clients.removeAll { $0.id == client.id }
		busyIDs.insert(client.id)
		actionError = nil
		defer { busyIDs.remove(client.id) }
		do {
			try await api.disconnectMCPClient(id: client.id, idempotencyKey: UUID().uuidString)
			return true
		} catch {
			clients = previous
			actionError = (error as? SettingsError)?.message ?? "Couldn't disconnect \(client.name)."
			return false
		}
	}

	public func dismissError() { actionError = nil }
}
