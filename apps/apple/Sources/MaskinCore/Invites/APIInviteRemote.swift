import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `InviteRemote`: the generated client behind a private adapter.
///
/// The shared app client stamps `Authorization` and `X-Workspace-Id` on every call, and the invite
/// routes want neither the workspace header (the person is joining a workspace they are not in) nor,
/// for the preview, any credentials at all. So this builds its own clients: one that sends nothing
/// for the preview, and one per accept that sends only the bearer key.
public struct APIInviteRemote: InviteRemote {
	private let makeClient: @Sendable (_ apiKey: String?) -> Client

	public init(baseURL: URL, clientSource: String, session: URLSession? = nil) {
		makeClient = { apiKey in
			MaskinClient.make(
				serverURL: baseURL, clientSource: clientSource,
				credentials: { apiKey.map { MaskinCredentials(apiKey: $0) } }, session: session)
		}
	}

	private func client(apiKey: String?) -> Client { makeClient(apiKey) }

	public func preview(token: String) async throws -> InvitePreview {
		let output: Operations.get_sol_api_sol_invites_sol_preview.Output
		do {
			output = try await client(apiKey: nil).get_sol_api_sol_invites_sol_preview(
				.init(query: .init(token: token)))
		} catch {
			throw InviteFailure.transport(error)
		}
		switch output {
		case .ok(let ok):
			let body: Operations.get_sol_api_sol_invites_sol_preview.Output.Ok.Body.jsonPayload
			do { body = try ok.body.json } catch { throw InviteFailure.unreadable }
			guard let expires = Self.parseDate(body.expiresAt) else { throw InviteFailure.unreadable }
			return InvitePreview(
				workspaceId: body.workspaceId, workspaceName: body.workspaceName,
				inviterName: body.inviterName, inviteEmail: body.inviteEmail, role: body.role,
				expiresAt: expires)
		case .notFound: throw InviteFailure.notFound
		case .gone: throw InviteFailure.expired
		case .tooManyRequests: throw InviteFailure.rateLimited
		case .undocumented(let status, _): throw InviteFailure.status(status)
		}
	}

	public func accept(token: String, apiKey: String) async throws -> InviteAcceptance {
		let output: Operations.acceptInvite.Output
		do {
			// No body: an empty body with a bearer key is the "join as myself" branch.
			output = try await client(apiKey: apiKey).acceptInvite(.init(path: .init(token: token)))
		} catch {
			throw InviteFailure.transport(error)
		}
		switch output {
		case .ok(let ok):
			do { return InviteAcceptance(workspaceId: try ok.body.json.workspaceId) } catch {
				throw InviteFailure.unreadable
			}
		case .created: throw InviteFailure.unreadable
		case .badRequest: throw InviteFailure.status(400)
		case .unauthorized: throw InviteFailure.sessionExpired
		case .forbidden: throw InviteFailure.seatCap
		case .notFound: throw InviteFailure.notFound
		case .gone: throw InviteFailure.expired
		case .undocumented(let status, _): throw InviteFailure.status(status)
		}
	}

	/// The server sends ISO 8601, with or without fractional seconds.
	static func parseDate(_ text: String) -> Date? {
		let fractional = ISO8601DateFormatter()
		fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		if let date = fractional.date(from: text) { return date }
		let plain = ISO8601DateFormatter()
		plain.formatOptions = [.withInternetDateTime]
		return plain.date(from: text)
	}
}
