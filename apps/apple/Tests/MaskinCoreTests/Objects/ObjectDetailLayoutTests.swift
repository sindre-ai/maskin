import Testing

@testable import MaskinCore

@Suite("ObjectDetailLayout")
struct ObjectDetailLayoutTests {
	@Test("text before the first heading is the lead")
	func lead() {
		let result = ObjectDetailLayout.sections(of: "Intro line.\n\n## Next\n- one\n- two")
		#expect(result.lead == "Intro line.")
		#expect(result.sections == [ObjectContentSection(heading: "Next", body: "- one\n- two")])
	}

	@Test("a description without headings is all lead")
	func noHeadings() {
		let result = ObjectDetailLayout.sections(of: "Just text.")
		#expect(result.lead == "Just text.")
		#expect(result.sections.isEmpty)
	}

	@Test("a hash line inside a code fence is not a heading")
	func fenced() {
		let result = ObjectDetailLayout.sections(of: "## Code\n```\n# not a heading\n```")
		#expect(result.sections.count == 1)
		#expect(result.sections[0].body.contains("# not a heading"))
	}

	@Test("empty sections and hashtags are dropped or kept as text")
	func edge() {
		let result = ObjectDetailLayout.sections(of: "#tag stays\n## Empty\n## Full\ntext")
		#expect(result.lead == "#tag stays")
		#expect(result.sections.map(\.heading) == ["Full"])
		#expect(ObjectDetailLayout.sections(of: nil).lead.isEmpty)
	}

	@Test("the flow is the first linked loop")
	func flow() {
		let task = ObjectLink(id: "1", relation: "informs", isOutgoing: true, otherId: "t", otherType: "task", otherTitle: "T")
		let loop = ObjectLink(id: "2", relation: "contains", isOutgoing: false, otherId: "l", otherType: "loop", otherTitle: "Sales")
		#expect(ObjectDetailLayout.flow(in: [task, loop])?.otherId == "l")
		#expect(ObjectDetailLayout.flow(in: [task]) == nil)
	}
}
