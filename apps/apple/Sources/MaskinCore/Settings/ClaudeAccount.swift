import Foundation
import Observation

/// One Claude subscription the workspace runs agents on (`GET /api/claude-oauth/status`).
public struct ClaudeSlot: Identifiable, Sendable, Equatable {
	public var id: String
	public var nickname: String?
	public var subscriptionType: String?
	public var expiresAt: Date?
	public var failureReason: String?

	public init(
		id: String, nickname: String? = nil, subscriptionType: String? = nil, expiresAt: Date? = nil,
		failureReason: String? = nil
	) {
		self.id = id
		self.nickname = nickname
		self.subscriptionType = subscriptionType
		self.expiresAt = expiresAt
		self.failureReason = failureReason
	}

	/// "Claude Max" from the subscription type; "Claude subscription" when the server omits it.
	public var planLabel: String {
		guard let type = subscriptionType?.trimmingCharacters(in: .whitespacesAndNewlines), !type.isEmpty
		else { return "Claude subscription" }
		return "Claude \(type.prefix(1).uppercased())\(type.dropFirst())"
	}

	public var title: String {
		let nick = nickname?.trimmingCharacters(in: .whitespacesAndNewlines)
		return (nick?.isEmpty == false) ? nick! : planLabel
	}

	public var isFailing: Bool { failureReason != nil }
}

public struct ClaudeAccountStatus: Sendable, Equatable {
	public var slots: [ClaudeSlot]
	public var slotsRemaining: Int
	public init(slots: [ClaudeSlot], slotsRemaining: Int) {
		self.slots = slots
		self.slotsRemaining = slotsRemaining
	}
}

public protocol ClaudeAccountAPI: Sendable {
	func status() async throws -> ClaudeAccountStatus
}

/// Settings › Integrations › Import from Claude. The app shows which subscriptions agents run on;
/// the import itself needs the credentials file from a computer, so it stays on the web.
@MainActor
@Observable
public final class ClaudeAccountStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading
		case loaded(ClaudeAccountStatus)
		case failed(String)
	}

	public private(set) var phase: Phase = .idle
	@ObservationIgnored private let api: any ClaudeAccountAPI

	public init(api: any ClaudeAccountAPI) { self.api = api }

	public var status: ClaudeAccountStatus? {
		if case .loaded(let s) = phase { return s }
		return nil
	}

	public func load() async {
		if status == nil { phase = .loading }
		do { phase = .loaded(try await api.status()) } catch {
			if status == nil {
				phase = .failed((error as? SettingsError)?.message ?? "Couldn't load your Claude account.")
			}
		}
	}
}

public struct APIClaudeAccountSource: ClaudeAccountAPI {
	private let http: SettingsHTTP
	public init(http: SettingsHTTP) { self.http = http }

	private struct Slot: Decodable {
		var position: Int
		var subscription_type: String?
		var expires_at: Double
		var nickname: String?
		var failure_reason: String?
	}

	private struct Wire: Decodable {
		var slots: [String: Slot]
		var chain: [String]
		var slots_remaining: Int
	}

	public func status() async throws -> ClaudeAccountStatus {
		let (data, status) = try await http.send("GET", "api/claude-oauth/status")
		guard status == 200 else {
			throw SettingsHTTP.error(
				status: status, data: data, fallback: "Couldn't load your Claude account.")
		}
		let wire = try SettingsHTTP.decode(Wire.self, data)
		let slots = wire.chain.compactMap { id -> ClaudeSlot? in
			guard let s = wire.slots[id] else { return nil }
			return ClaudeSlot(
				id: id, nickname: s.nickname, subscriptionType: s.subscription_type,
				// The server counts seconds or milliseconds depending on the issuer; both are read.
				expiresAt: Date(timeIntervalSince1970: s.expires_at > 1e11 ? s.expires_at / 1000 : s.expires_at),
				failureReason: s.failure_reason)
		}
		return ClaudeAccountStatus(slots: slots, slotsRemaining: wire.slots_remaining)
	}
}
