import Foundation

/// Port of `buildSignupCaptureKnowledge()` in
/// `packages/shared/src/schemas/signup-capture.ts` — the wire contract a "Strategist
/// research-on-signup" trigger reads back, so the shape (type/status/title/content/
/// metadata keys) must match exactly, not just look similar.
enum SignupCapture {
	static func objectBody(name: String, organization: String, role: String) -> ObjectsAPI.CreateBody {
		let content = [
			"**Name:** \(name)",
			"**Organization:** \(organization)",
			"**Role:** \(role)",
			"",
			"_Captured at signup. Source of truth for new-workspace context._",
		].joined(separator: "\n")

		let metadata: [String: JSONValue] = [
			"source": .string("signup_capture"),
			"name": .string(name),
			"organization": .string(organization),
			"role": .string(role),
			"summary": .string("Signup context for \(name) — \(role) at \(organization)."),
			"confidence": .string("high"),
			"tags": .array([.string("context:user"), .string("context:company")]),
			"last_validated_at": .string(ISO8601DateFormatter().string(from: Date())),
		]

		return ObjectsAPI.CreateBody(
			type: "knowledge",
			title: "Signup context — \(name)",
			content: content,
			status: "validated",
			metadata: metadata
		)
	}
}
