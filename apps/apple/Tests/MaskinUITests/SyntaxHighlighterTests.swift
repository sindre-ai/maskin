import Testing

@testable import MaskinUI

@Suite("SyntaxHighlighter") struct SyntaxHighlighterTests {
	/// Each token as `kind:text`, in order.
	private func lex(_ code: String, _ language: String?) -> [String] {
		let chars = Array(code)
		return SyntaxHighlighter.tokens(in: code, language: language).map {
			"\($0.kind):\(String(chars[$0.start..<$0.end]))"
		}
	}

	@Test func swiftKeywordsTypesLiteralsAndStrings() {
		let tokens = lex("let name: String = \"a\\\"b\" // note\nreturn nil", "swift")
		#expect(tokens == [
			"keyword:let", "type:String", "string:\"a\\\"b\"", "comment:// note", "keyword:return", "literal:nil",
		])
	}

	@Test func numbersAndHex() {
		#expect(lex("x = 42 + 0xFF + 3.14", "python") == ["number:42", "number:0xFF", "number:3.14"])
	}

	@Test func pythonHashCommentsAndTripleQuotes() {
		let tokens = lex("def f():\n    \"\"\"doc\n    more\"\"\"  # trailing\n    return True", "py")
		#expect(tokens == [
			"keyword:def", "string:\"\"\"doc\n    more\"\"\"", "comment:# trailing", "keyword:return", "literal:True",
		])
	}

	@Test func jsTemplateLiteralsMayRunAcrossLines() {
		#expect(lex("const s = `a\nb`", "ts") == ["keyword:const", "string:`a\nb`"])
	}

	@Test func jsonKeysAreNotStrings() {
		#expect(lex("{\"a\": \"b\", \"n\": 1, \"ok\": true}", "json") == [
			"property:\"a\"", "string:\"b\"", "property:\"n\"", "number:1", "property:\"ok\"", "literal:true",
		])
	}

	@Test func yamlKeys() {
		#expect(lex("name: maskin\nretries: 3 # x", "yaml") == ["property:name", "property:retries", "number:3", "comment:# x"])
	}

	@Test func shellVariablesAndHashComments() {
		#expect(lex("echo $HOME # hi", "bash") == ["keyword:echo", "property:$HOME", "comment:# hi"])
	}

	@Test func sqlKeywordsAreCaseInsensitive() {
		#expect(lex("SELECT id FROM t WHERE x = 'y'", "sql") == [
			"keyword:SELECT", "keyword:FROM", "keyword:WHERE", "string:'y'",
		])
	}

	@Test func swiftAttributesAndDirectivesAreNotComments() {
		#expect(lex("@MainActor\n#if DEBUG", "swift") == ["keyword:@MainActor", "keyword:#if"])
	}

	@Test func blockCommentsAndUnterminatedThingsRunToTheEnd() {
		#expect(lex("a /* x\ny */ b", "go") == ["comment:/* x\ny */"])
		#expect(lex("x = \"open", "js") == ["string:\"open"])
		#expect(lex("/* never closed", "c") == ["comment:/* never closed"])
	}

	@Test func aQuoteInsideAStringOrCommentDoesNotStartAnother() {
		#expect(lex("// it's fine\nx = 1", "swift") == ["comment:// it's fine", "number:1"])
		#expect(lex("\"it's\"", "json") == ["string:\"it's\""])
	}

	@Test func unknownOrMissingLanguageIsPlain() {
		#expect(lex("let x = 1", nil).isEmpty)
		#expect(lex("let x = 1", "brainfuck").isEmpty)
		#expect(!SyntaxHighlighter.supports("brainfuck"))
		#expect(SyntaxHighlighter.supports(" Swift "))
	}

	@Test func attributedTextKeepsEveryCharacterAndColoursOnlyTokens() {
		let code = "let x = 1 // n\n\tfoo()"
		let attr = SyntaxHighlighter.attributed(code, language: "swift")
		#expect(String(attr.characters) == code)
		#expect(attr.runs.contains { $0.foregroundColor != nil })
		let plain = SyntaxHighlighter.attributed(code, language: nil)
		#expect(plain.runs.allSatisfy { $0.foregroundColor == nil })
	}

	@Test func emptyAndHugeInputsDoNotCrash() {
		#expect(lex("", "swift").isEmpty)
		_ = SyntaxHighlighter.attributed(String(repeating: "let a = \"x\" // c\n", count: 3000), language: "swift")
	}
}
