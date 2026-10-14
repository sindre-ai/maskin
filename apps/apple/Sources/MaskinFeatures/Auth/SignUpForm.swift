import Foundation
import MaskinCore

/// The create-account form's rules. They mirror `createActorSchema` for a human
/// (`packages/shared/src/schemas/actors.ts`): a non-empty name, a valid email, and a password of
/// at least 8 characters (counted in UTF-16 units, as the server's zod `min(8)` counts them).
/// The server stays the authority; this only keeps the obvious mistakes off the network.
struct SignUpForm: Equatable {
	static let minPasswordLength = 8

	var name = ""
	var email = ""
	var password = ""

	var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
	var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

	var nameProblem: String? {
		trimmedName.isEmpty ? "Enter your name." : nil
	}

	var emailProblem: String? {
		let e = trimmedEmail
		if e.isEmpty { return "Enter your email." }
		return Self.looksLikeEmail(e) ? nil : "That doesn't look like an email address."
	}

	var passwordProblem: String? {
		passwordLength >= Self.minPasswordLength
			? nil : "Use at least \(Self.minPasswordLength) characters."
	}

	var passwordLength: Int { password.utf16.count }

	var canSubmit: Bool { nameProblem == nil && emailProblem == nil && passwordProblem == nil }

	/// `local@domain.tld`, no spaces: the same shape zod's `.email()` insists on, minus its
	/// long tail of edge cases.
	static func looksLikeEmail(_ value: String) -> Bool {
		guard !value.contains(where: \.isWhitespace) else { return false }
		let parts = value.split(separator: "@", omittingEmptySubsequences: false)
		guard parts.count == 2, !parts[0].isEmpty else { return false }
		let domain = parts[1].split(separator: ".", omittingEmptySubsequences: false)
		return domain.count >= 2 && domain.allSatisfy { !$0.isEmpty }
	}
}

extension SignUpError {
	/// Plain-language text for the inline error above the button. Field-level problems are shown
	/// under their fields instead (`invalid` with a known field); this is the fallback line.
	var message: String {
		switch self {
		case .emailTaken:
			"Email already exists. Sign in instead, or use another email."
		case .invalid(let fields):
			fields.values.sorted().first ?? "Check the details and try again."
		case .rateLimited:
			"Too many attempts. Wait a minute and try again."
		case .server(let status):
			"Maskin is having trouble right now (error \(status)). Try again in a moment."
		case .network:
			"Can't reach Maskin. Check your connection and try again."
		}
	}
}

/// Build-time switches and links, read from the app's Info.plist so a store build can change them
/// without a code change. Absent keys mean the default: sign-up on, no legal links.
///
/// - `MaskinEnableSignUp` (Bool): `false` hides "Create account" entirely (App Store builds,
///   until the backend offers in-app account deletion; see `docs/app-store-notes.md`).
/// - `MaskinTermsURL` / `MaskinPrivacyURL` (String): the legal pages. Nothing is invented: when a
///   key is missing, that link isn't shown.
struct AuthConfig: Equatable {
	var signUpEnabled = true
	var termsURL: URL?
	var privacyURL: URL?

	init(signUpEnabled: Bool = true, termsURL: URL? = nil, privacyURL: URL? = nil) {
		self.signUpEnabled = signUpEnabled
		self.termsURL = termsURL
		self.privacyURL = privacyURL
	}

	init(info: [String: Any]?) {
		let info = info ?? [:]
		switch info["MaskinEnableSignUp"] {
		case let flag as Bool: signUpEnabled = flag
		case let text as String: signUpEnabled = !["no", "false", "0"].contains(text.lowercased())
		default: signUpEnabled = true
		}
		termsURL = Self.webURL(info["MaskinTermsURL"])
		privacyURL = Self.webURL(info["MaskinPrivacyURL"])
	}

	static var current: AuthConfig { AuthConfig(info: Bundle.main.infoDictionary) }

	/// Only `https` links: a legal link must not be able to open anything else.
	private static func webURL(_ raw: Any?) -> URL? {
		guard let text = raw as? String, let url = URL(string: text), url.scheme?.lowercased() == "https",
			url.host?.isEmpty == false
		else { return nil }
		return url
	}
}
