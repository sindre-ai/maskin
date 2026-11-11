import MaskinDesign
import Testing

@testable import MaskinUI

@Suite("Status and type mapping") struct BadgeMappingTests {
	/// Every key of `statusColors` in apps/web/src/lib/constants.ts.
	static let webStatuses = [
		"new", "backlog", "todo", "processing", "in_progress", "active", "opportunity", "proposed",
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
		#expect(MaskinObjectType.symbol(for: "release_note") == nil)
		#expect(MaskinObjectType.glyph(for: "release_note") == "square")
		#expect(MaskinObjectType.symbol(for: "account") == "building.2")
	}

	@Test func aliasesShareTheirTargetColours() {
		#expect(MaskinStatus.tokenKey(for: "running") == "active")
		#expect(MaskinStatus.tokenKey(for: "at-risk") == "at_risk")
		#expect(MaskinStatus.tokenKey(for: "waiting_for_input") == "blocked")
	}

	@Test(arguments: ["done", "completed", "succeeded", "paid"]) func doneIsInkNeverGreen(status: String) {
		let colors = MaskinStatus.colors(for: status)
		#expect(colors.fg == MaskinColor.doneFg)
		#expect(colors.bg == MaskinColor.doneBg)
	}

	@Test func labels() {
		#expect(MaskinStatus.label(for: "in_progress") == "In progress")
		#expect(MaskinStatus.label(for: "todo") == "To do")
		#expect(MaskinStatus.label(for: "waiting_for_input") == "Needs you")
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

	@Test("a short all-caps role and a three-word name show three letters, everything else stays at two")
	func threeLetterAcronyms() {
		#expect(ActorIdentity.initials(for: "CTO") == "CTO")
		#expect(ActorIdentity.initials(for: "PMM") == "PMM")
		#expect(ActorIdentity.initials(for: "(CPO)") == "CPO")
		#expect(ActorIdentity.initials(for: "QA") == "QA")
		#expect(ActorIdentity.initials(for: "Cto") == "CT")
		#expect(ActorIdentity.initials(for: "NASA") == "NA")
		#expect(ActorIdentity.initials(for: "Chief of Staff") == "COS")
		#expect(ActorIdentity.initials(for: "Head of Customer Success") == "HOC")
		#expect(ActorIdentity.initials(for: "Linker (Sigrid) Lead") == "LSL")
		#expect(ActorIdentity.initials(for: "Sebastian Krumhausen") == "SK")
		#expect(ActorIdentity.initials(for: "CTO Agent") == "CA")
	}

	@Test("the plate hue follows the mockup's (h * 31 + c) % 360 and is stable")
	func plateHue() {
		#expect(ActorIdentity.hue(seed: "a") == (0 * 31 + 97) % 360)
		#expect(ActorIdentity.hue(seed: "ab") == (97 * 31 + 98) % 360)
		#expect(ActorIdentity.hue(seed: "Forge") == ActorIdentity.hue(seed: "Forge"))
		#expect((0..<360).contains(ActorIdentity.hue(seed: "Some long actor id 123")))
		#expect(ActorIdentity.hue(seed: "") == ActorIdentity.hue(seed: "?"))
	}

	@Test("an agent keeps the same shape and colour on every call")
	func agentLookIsStable() {
		#expect(ActorIdentity.agentShape(seed: "relay-1") == ActorIdentity.agentShape(seed: "relay-1"))
		#expect(
			ActorIdentity.paletteIndex(seed: "relay-1", kind: .agent)
				== ActorIdentity.paletteIndex(seed: "relay-1", kind: .agent))
	}

	@Test("seeds spread over every shape, and shape varies independently of colour")
	func agentShapesSpread() {
		let seeds = (0..<200).map { "agent-\($0)" }
		let shapes = Set(seeds.map { ActorIdentity.agentShape(seed: $0) })
		#expect(shapes.count == AgentShape.allCases.count)
		let looks = Set(seeds.map { "\(ActorIdentity.paletteIndex(seed: $0, kind: .agent))-\(ActorIdentity.agentShape(seed: $0))" })
		#expect(looks.count > AgentShape.allCases.count)
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
