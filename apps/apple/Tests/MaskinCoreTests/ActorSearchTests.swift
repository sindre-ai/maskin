import Testing

@testable import MaskinCore

@Suite("ActorSearch")
struct ActorSearchTests {
	private func names(_ query: String, in all: [String]) -> [String] {
		ActorSearch.filter(all, query: query) { $0 }
	}

	@Test func emptyQueryKeepsEverythingInOrder() {
		#expect(names("  ", in: ["Zed", "Abe"]) == ["Zed", "Abe"])
	}

	@Test func ignoresCaseAndDiacritics() {
		#expect(names("RENE", in: ["René Hansen", "Ida"]) == ["René Hansen"])
	}

	@Test func ranksPrefixThenWordStartThenContains() {
		let all = ["Chief of Staff", "Bridge", "Ida Rig", "Rigel"]
		#expect(names("ri", in: all) == ["Rigel", "Ida Rig", "Bridge"])
	}

	@Test func equalRanksKeepInputOrder() {
		#expect(names("a", in: ["Ann", "Abe", "Al"]) == ["Ann", "Abe", "Al"])
	}

	@Test func nonMatchesAreDropped() {
		#expect(names("zz", in: ["Ann"]).isEmpty)
		#expect(ActorSearch.rank(name: "Ann", query: "zz") == nil)
	}
}
