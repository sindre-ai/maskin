import Foundation
import Testing

@testable import MaskinCore

@Suite("SecretScanner")
struct SecretScannerTests {
	private let stripe = "sk_live_" + String(repeating: "a1B2", count: 7)
	private let github = "ghp_" + String(repeating: "x", count: 36)
	private let cloudflare = "cfut_" + String(repeating: "Z", count: 44)

	@Test func findsEachProvidersKeyInsideASentence() throws {
		for (secret, id) in [(stripe, "stripe"), (github, "github"), (cloudflare, "cloudflare")] {
			let hit = try #require(SecretScanner.firstSecret(in: "here is the key \(secret) thanks"))
			#expect(hit.patternID == id)
			#expect(hit.value == secret)
		}
		#expect(SecretScanner.firstSecret(in: "xoxb-" + String(repeating: "1", count: 24))?.patternID == "slack")
		#expect(SecretScanner.firstSecret(in: "sk-proj-" + String(repeating: "a", count: 48))?.patternID == "openai-style")
	}

	@Test func ordinaryTextAndShortStringsAreNotSecrets() {
		#expect(SecretScanner.firstSecret(in: "please check the sk-ant docs and ghp_ prefix") == nil)
		#expect(SecretScanner.firstSecret(in: "sk_live_tooShort") == nil)
		#expect(SecretScanner.firstSecret(in: "") == nil)
	}

	@Test func aStripeKeyIsNotAlsoReportedAsAnApiKeyStyleSecret() {
		#expect(SecretScanner.scan(stripe).count == 1)
	}

	@Test func cutsASecretOutAndKeepsTheWords() {
		let text = "use \(stripe) for billing"
		#expect(SecretScanner.withoutSecrets(text, SecretScanner.scan(text)) == "use for billing")
	}

	@Test func replacesASecretWithAMarkerThatKeepsItsPrefix() {
		let text = "use \(stripe) now"
		#expect(
			SecretScanner.redacted(text, SecretScanner.scan(text), name: "Stripe")
				== "use sk_live_[REDACTED · vaulted as Stripe] now")
		#expect(SecretScanner.redactionMarker(for: cloudflare, name: "CF") == "cfut_[REDACTED · vaulted as CF]")
		// The marker never matches a pattern, so a redacted message is never refused again.
		#expect(SecretScanner.firstSecret(in: SecretScanner.redactionMarker(for: stripe, name: "Stripe")) == nil)
	}

	@Test func showsOnlyTheEndsOfASecret() {
		#expect(SecretScanner.masked(github) == "ghp_…xxxx")
		#expect(!SecretScanner.masked(stripe).contains(String(stripe.dropFirst(10).dropLast(6))))
	}

	/// The server refuses on the TypeScript table, so this port must list the same rows.
	@Test func listsTheSameHighConfidenceRowsAsTheSharedTable() throws {
		var url = URL(fileURLWithPath: #filePath)
		for _ in 0..<6 { url.deleteLastPathComponent() }
		let ts = try String(contentsOf: url.appendingPathComponent("packages/shared/src/secret-scanner.ts"), encoding: .utf8)
		// One row: id, confidence, provider, source (a single-quoted TS string with doubled backslashes).
		let row = try Regex(#"id: '([^']+)',\s*confidence: 'high',[^}]*?source: '((?:[^'\\]|\\.)*)'"#)
		var shared: [(String, String)] = []
		for match in ts.matches(of: row) {
			let id = String(match.output[1].substring ?? "")
			let source = String(match.output[2].substring ?? "").replacingOccurrences(of: "\\\\", with: "\\")
			shared.append((id, source))
		}
		#expect(shared.count == 5)
		#expect(shared.map(\.0) == SecretScanner.highConfidence.map(\.id))
		#expect(shared.map(\.1) == SecretScanner.highConfidence.map(\.source))
	}
}
