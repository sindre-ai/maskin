import Foundation

/// Native connect flow for Slack, GitHub and LinkedIn: the app asks the API for an install URL,
/// shows it in a system web-authentication sheet, and the server finishes by redirecting that
/// sheet to `maskin://integrations/callback?...`. Nothing secret is in that URL (identifiers and
/// a status only), and nothing below logs it.

/// A provider's start-connect answer.
public struct IntegrationConnectStart: Sendable, Equatable {
	public var installURL: URL
	/// LinkedIn names the pending integration up front; the others report it in the callback.
	public var integrationId: String?

	public init(installURL: URL, integrationId: String? = nil) {
		self.installURL = installURL
		self.integrationId = integrationId
	}
}

/// An installation a GitHub connect can bind to. `name` is the account's login; it is `nil` when
/// GitHub didn't give one, and the screen then says "GitHub account" rather than show the id.
public struct GitHubInstallationChoice: Identifiable, Sendable, Equatable {
	public var id: String
	public var name: String?

	public init(id: String, name: String?) {
		self.id = id
		self.name = name
	}
}

/// Why a connect ended in `error`. Mirrors the server's `NativeOAuthErrorReason`.
public enum IntegrationConnectFailure: String, Sendable, Equatable, CaseIterable {
	case denied
	case stateExpired = "state_expired"
	case invalidState = "invalid_state"
	case notBound = "not_bound"
	case notMember = "not_member"
	case missingCode = "missing_code"
	case tokenExchangeFailed = "token_exchange_failed"
	case installationUnauthorized = "installation_unauthorized"
	case postInstallFailed = "post_install_failed"
	case peopleIdFetchFailed = "people_id_fetch_failed"
	case enumerationFailed = "enumeration_failed"
	case accountRestricted = "account_restricted"
	case unsupported
	case unknown
}

/// What the callback URL said.
public enum IntegrationConnectOutcome: Sendable, Equatable {
	/// `billingRequired`: LinkedIn trial workspace; the add-on is paid for on the web.
	case connected(integrationId: String?, billingRequired: Bool)
	/// GitHub only: several installations are reachable; finish with the picker.
	case selectionRequired(integrationId: String)
	case failed(IntegrationConnectFailure)

	/// The only return target the app ever asks the server for. Matched exactly on both sides.
	public static let returnURL = "maskin://integrations/callback"
	public static let callbackScheme = "maskin"

	/// True for `maskin://integrations/callback` with any query. The deep-link router uses this to
	/// leave such a URL alone instead of treating it as an unrecognised link.
	public static func isCallback(_ url: URL) -> Bool {
		guard url.scheme?.lowercased() == callbackScheme, url.host?.lowercased() == "integrations"
		else { return false }
		return url.path == "/callback"
	}

	/// Anything that isn't a well-formed callback, an unknown status or reason, or a missing
	/// required parameter becomes `.failed(.unknown)`: never a crash, never a silent success.
	public static func parse(_ url: URL) -> IntegrationConnectOutcome {
		guard isCallback(url), let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
		else { return .failed(.unknown) }
		func value(_ name: String) -> String? {
			items.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 }
		}
		switch value("status") {
		case "connected":
			return .connected(integrationId: value("integration_id"), billingRequired: value("billing") == "required")
		case "selection_required":
			guard let id = value("integration_id") else { return .failed(.unknown) }
			return .selectionRequired(integrationId: id)
		case "error":
			let reason = value("reason").flatMap(IntegrationConnectFailure.init(rawValue:))
			return .failed(reason ?? .unknown)
		default:
			return .failed(.unknown)
		}
	}
}

/// Runs a system web-authentication sheet. A fake in tests; `ASWebAuthenticationSession` in the app.
public protocol WebAuthenticating: Sendable {
	/// Opens `url` and returns the URL the sheet was redirected to on `callbackScheme`.
	/// Throws `WebAuthenticationError.cancelled` when the person closes the sheet.
	@MainActor func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

public enum WebAuthenticationError: Error, Sendable, Equatable {
	case cancelled
	case unavailable
}

/// What the screen shows after a connect attempt.
public struct IntegrationConnectNotice: Sendable, Equatable {
	public enum Kind: Sendable, Equatable { case success, info, failure }
	public var kind: Kind
	public var text: String

	public init(_ kind: Kind, _ text: String) {
		self.kind = kind
		self.text = text
	}
}

/// Plain sentences for every outcome. `name` is the provider's display name, never its id.
public enum IntegrationConnectCopy {
	public static func connected(_ name: String) -> IntegrationConnectNotice {
		IntegrationConnectNotice(.success, "\(name) is connected.")
	}

	/// Neutral and informational on purpose: no action, no link, no price.
	public static func connectedBillingRequired(_ name: String) -> IntegrationConnectNotice {
		IntegrationConnectNotice(
			.info,
			"\(name) is connected. Billing for this connection must be completed on the web by the workspace owner.")
	}

	public static func cancelled(_ name: String) -> IntegrationConnectNotice {
		IntegrationConnectNotice(.info, "\(name) wasn't connected. You closed the sign-in before it finished.")
	}

	public static let offline = IntegrationConnectNotice(
		.failure, "You're offline. Connect again when you have a connection.")

	public static func couldNotStart(_ name: String) -> IntegrationConnectNotice {
		IntegrationConnectNotice(.failure, "Couldn't start connecting \(name). Try again in a moment.")
	}

	public static func failure(_ reason: IntegrationConnectFailure, name: String) -> IntegrationConnectNotice {
		IntegrationConnectNotice(.failure, failureText(reason, name: name))
	}

	public static func failureText(_ reason: IntegrationConnectFailure, name: String) -> String {
		switch reason {
		case .denied:
			"\(name) wasn't connected because access was declined."
		case .stateExpired, .invalidState, .notBound:
			"That sign-in expired or didn't start from this device. Try connecting \(name) again."
		case .notMember:
			"You're not a member of this workspace, so you can't connect \(name) to it."
		case .missingCode, .tokenExchangeFailed, .postInstallFailed:
			"\(name) didn't finish signing in. Try connecting again."
		case .installationUnauthorized:
			"Your \(name) account doesn't have access to that installation. Pick one you can use, or ask its owner."
		case .peopleIdFetchFailed, .enumerationFailed:
			"Couldn't read your \(name) account details. Try connecting again."
		case .accountRestricted:
			"\(name) restricted this account, so it can't be connected right now."
		case .unsupported:
			"\(name) can't be connected from the app yet."
		case .unknown:
			"Something went wrong connecting \(name). Try again."
		}
	}
}
