import MaskinDesign
import Testing

@testable import MaskinUI

@Suite("Status and type mapping") struct BadgeMappingTests {
	/// Every key of `statusColors` in apps/web/src/lib/constants.ts.
	static let webStatuses = [
		"new", "backlog", "todo", "processing", "in_progress", "active", "signal", "proposed",
		"clustered", "done", "completed", "succeeded", "queued", "blocked", "failed", "paused",
		"discarded", "qualified", "define", "live", "scored", "parked", "archived", "in_review",
		"validated", "holding", "at-risk", "breached", "pending", "starting", "running",
		"snapshotting", "waiting_for_input", "timeout", "paid", "inactive", "past_due", "declined",
		"canceled",
	]
	/// Every key of `typeColors` in apps/web/src/lib/constants.ts.
	static let webTypes = ["insight", "bet", "task", "file", "conversation", "session"]

	@Test(arguments: webStatuses) func everyWebStatusHasTokens(status: String) {
		#expect(MaskinStatus.tokenKey(for: status) != nil, "\(status) fell back to the neutral pair")
	}

	@Test(arguments: webTypes) func everyWebTypeHasTokensAndGlyph(type: String) {
		#expect(MaskinObjectType.tokenKey(for: type) != nil)
		#expect(MaskinObjectType.symbol(for: type) != nil)
	}

	@Test func aliasesPointAtRealTokens() {
		for (alias, target) in MaskinStatus.aliases {
			#expect(MaskinStatusPalette.all[target] != nil, "\(alias) → \(target) has no palette entry")
		}
	}

	@Test func unknownStatusAndTypeFallBackToNeutral() {
		#expect(MaskinStatus.tokenKey(for: "my_custom_status") == nil)
		#expect(MaskinObjectType.tokenKey(for: "article") == nil)
		#expect(MaskinObjectType.symbol(for: "article") == nil)
	}

	@Test func aliasesShareTheirTargetColours() {
		#expect(MaskinStatus.tokenKey(for: "running") == "active")
		#expect(MaskinStatus.tokenKey(for: "at-risk") == "at_risk")
		#expect(MaskinStatus.tokenKey(for: "waiting_for_input") == "blocked")
	}

	@Test func labels() {
		#expect(MaskinStatus.label(for: "in_progress") == "In progress")
		#expect(MaskinStatus.label(for: "todo") == "To do")
		#expect(MaskinStatus.label(for: "waiting_for_input") == "waiting for input")
		#expect(MaskinStatus.sentenceLabel(for: "blocked") == "Blocked")
	}
}

@Suite("ActorIdentity") struct ActorIdentityTests {
	@Test func initials() {
		#expect(ActorIdentity.initials(for: "Sindre Ahl") == "SA")
		#expect(ActorIdentity.initials(for: "Magnus") == "MA")
		#expect(ActorIdentity.initials(for: "Linker (Sigrid)") == "LS")
		#expect(ActorIdentity.initials(for: "  ") == "?")
		#expect(ActorIdentity.initials(for: "") == "?")
		#expect(ActorIdentity.initials(for: "x") == "X")
	}

	@Test func hashMatchesWebDjb2() {
		// Computed with the web's hashString: ((h << 5) + h) ^ charCode, >>> 0, seed 5381.
		#expect(ActorIdentity.bucketHash("a") == (5381 &* 33) ^ 97)
		#expect(ActorIdentity.bucketHash("") == 5381)
	}

	@Test func bucketIsStableAndInRange() {
		for kind in [ActorAvatar.Kind.human, .agent] {
			let count = kind == .agent ? ActorIdentity.agentPalette.count : ActorIdentity.humanPaletteKeys.count
			let first = ActorIdentity.paletteIndex(seed: "Forge", kind: kind)
			#expect(first == ActorIdentity.paletteIndex(seed: "Forge", kind: kind))
			#expect((0..<count).contains(first))
		}
	}

	@Test func humanPaletteKeysExist() {
		for key in ActorIdentity.humanPaletteKeys { #expect(MaskinStatusPalette.all[key] != nil) }
	}
}
