import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `NotificationPreferencesAPI`. Reads through the generated client. Writes are a plain
/// `URLSession` request because the generated request payload drops `nil` fields, and the server
/// needs an explicit `null` to clear the timezone or quiet hours. These routes are per actor, so
/// no `X-Workspace-Id`. Error text is fixed: no bodies, ids or keys are interpolated.
public struct APINotificationPreferencesSource: NotificationPreferencesAPI {
	private let client: Client
	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let session: URLSession

	public init(
		client: Client, baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .shared
	) {
		self.client = client
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	public func load() async throws -> NotificationPreferences {
		let output: Operations.get_sol_api_sol_notification_hyphen_preferences.Output
		do {
			output = try await client.get_sol_api_sol_notification_hyphen_preferences(.init())
		} catch {
			throw SettingsError("Couldn't load your notification settings.")
		}
		guard case .ok(let ok) = output, let body = try? ok.body.json else {
			throw SettingsError("Couldn't load your notification settings.")
		}
		return NotificationPreferences(
			timezone: body.timezone,
			quietHours: Self.quietHours(start: body.quiet_hours_start, end: body.quiet_hours_end),
			categories: .init(
				needsYou: body.categories.needs_you, conversation: body.categories.conversation,
				digest: body.categories.digest, tips: body.categories.tips,
				flowActivity: body.categories.flow_activity),
			briefingEnabled: body.briefing_enabled, briefingTime: body.briefing_time,
			emailDigestEnabled: body.email_digest_enabled,
			emailNeedsYou: body.email_categories.needs_you,
			emailConversation: body.email_categories.conversation,
			emailTips: body.email_categories.tips,
			emailFlowActivity: body.email_categories.flow_activity,
			mutedWorkspaceIds: body.muted_workspace_ids)
	}

	public func save(_ patch: NotificationPreferencesPatch, idempotencyKey: String) async throws
		-> NotificationPreferences
	{
		var request = await makeRequest(patch: patch, idempotencyKey: idempotencyKey)
		request.httpBody = try patch.jsonBody()
		let data: Data
		let status: Int
		do {
			let (body, response) = try await session.data(for: request)
			data = body
			status = (response as? HTTPURLResponse)?.statusCode ?? 0
		} catch {
			throw SettingsError("Couldn't reach Maskin. Check your connection and try again.")
		}
		guard status == 200 else { throw SettingsError("Couldn't save your notification settings.") }
		guard let wire = try? JSONDecoder().decode(Wire.self, from: data) else {
			throw SettingsError("Maskin sent a reply this version can't read.")
		}
		return wire.model
	}

	/// Built apart from sending so tests can read the headers.
	func makeRequest(patch: NotificationPreferencesPatch, idempotencyKey: String) async -> URLRequest {
		var request = URLRequest(url: baseURL.appendingPathComponent("api/notification-preferences"))
		request.httpMethod = "PUT"
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
		}
		return request
	}

	static func quietHours(start: Int?, end: Int?) -> NotificationPreferences.QuietHours? {
		guard let start, let end else { return nil }
		return .init(start: start, end: end)
	}

	/// The response body, decoded by hand to match the PUT.
	struct Wire: Decodable {
		struct Categories: Decodable {
			var needs_you: Bool
			var conversation: Bool
			var digest: Bool
			var tips: Bool
			/// Absent from a server that predates Flow activity.
			var flow_activity: Bool?
		}
		struct EmailCategories: Decodable {
			var needs_you: Bool?
			var conversation: Bool?
			var tips: Bool?
			var flow_activity: Bool?
		}
		var timezone: String?
		var quiet_hours_start: Int?
		var quiet_hours_end: Int?
		var categories: Categories
		var briefing_enabled: Bool
		var briefing_time: Int
		/// Absent from a server that predates the email switch.
		var email_digest_enabled: Bool?
		/// Absent from a server that predates Flow activity.
		var email_categories: EmailCategories?
		var muted_workspace_ids: [String]

		var model: NotificationPreferences {
			NotificationPreferences(
				timezone: timezone,
				quietHours: APINotificationPreferencesSource.quietHours(start: quiet_hours_start, end: quiet_hours_end),
				categories: .init(
					needsYou: categories.needs_you, conversation: categories.conversation,
					digest: categories.digest, tips: categories.tips,
					flowActivity: categories.flow_activity ?? false),
				briefingEnabled: briefing_enabled, briefingTime: briefing_time,
				emailDigestEnabled: email_digest_enabled ?? false,
				emailNeedsYou: email_categories?.needs_you ?? false,
				emailConversation: email_categories?.conversation ?? false,
				emailTips: email_categories?.tips ?? false,
				emailFlowActivity: email_categories?.flow_activity ?? false,
				mutedWorkspaceIds: muted_workspace_ids)
		}
	}
}
