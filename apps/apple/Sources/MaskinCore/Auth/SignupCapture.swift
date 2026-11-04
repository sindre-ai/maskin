import Foundation

/// The workspace knowledge object the web sign-up writes right after the account exists, so the
/// Strategist/Researcher onboarding has who-and-where to start from. Mirrors
/// `buildSignupCaptureKnowledge` in `packages/shared/src/schemas/signup-capture.ts`; the server
/// reads `metadata.source == "signup_capture"` to find it, so the wire layout must not drift.
public struct SignupCapture: Sendable, Equatable {
	public static let source = "signup_capture"
	public static let status = "validated"
	public static let tags = ["context:user", "context:company"]
	/// The shared schema caps each field at 200 characters.
	public static let maxFieldLength = 200

	public let name: String
	public let organization: String
	public let role: String

	/// Nil when any field is blank after trimming: the same inputs the shared schema rejects.
	public init?(name: String, organization: String, role: String) {
		func clean(_ s: String) -> String {
			String(s.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.maxFieldLength))
		}
		self.name = clean(name)
		self.organization = clean(organization)
		self.role = clean(role)
		guard !self.name.isEmpty, !self.organization.isEmpty, !self.role.isEmpty else { return nil }
	}

	public var title: String { "Signup context — \(name)" }

	public var content: String {
		[
			"**\(name)** works as **\(role)** at **\(organization)**.",
			"",
			"This is the workspace's source of truth for who signed up — Researcher uses it to put together a first-pass brief.",
			"",
			"_Captured at signup._",
		].joined(separator: "\n")
	}

	public var summary: String { "Signup context for \(name) — \(role) at \(organization)." }

	public func metadata(validatedAt: Date = Date()) -> [String: any Sendable] {
		[
			"source": Self.source,
			"name": name,
			"organization": organization,
			"role": role,
			"summary": summary,
			"confidence": "high",
			"tags": Self.tags,
			"last_validated_at": validatedAt.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: true).timeZone(separator: .omitted)),
		]
	}
}
