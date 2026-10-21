import Foundation
import MaskinDesign
import SwiftUI

/// What a stretch of code is, for colouring.
public enum SyntaxKind: Sendable, Equatable {
	case keyword, string, number, comment, type, literal, property
}

public struct SyntaxToken: Sendable, Equatable {
	/// Character offsets into the code: `start..<end`.
	public var start: Int
	public var end: Int
	public var kind: SyntaxKind
}

/// A small lexer that colours code well enough to read, not to compile: keywords, strings,
/// numbers, comments, types, literals and object keys. It never fails: anything it doesn't
/// understand is left plain, and an unterminated string or comment simply runs to the end.
public enum SyntaxHighlighter {
	struct Language {
		var keywords: Set<String> = []
		var literals: Set<String> = ["true", "false", "null", "nil", "none", "undefined"]
		var lineComments: [String] = ["//"]
		var blockComment: (open: String, close: String)? = ("/*", "*/")
		var quotes: Set<Character> = ["\"", "'"]
		/// Strings that may span lines (template literals, Python's triple quotes).
		var multilineQuotes: Set<Character> = ["`"]
		var tripleQuotes = false
		/// `name:` and `"name":` are object keys.
		var colonKeys = false
		var caseInsensitive = false
		/// `$name` and `@name` take the keyword colour (shell variables, Swift attributes).
		var sigils: Set<Character> = []
		var typesByCapital = true
	}

	private static let cLike: Set<String> = [
		"if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue", "return",
		"struct", "enum", "union", "typedef", "static", "const", "void", "int", "char", "long", "short",
		"float", "double", "unsigned", "signed", "sizeof", "goto", "extern", "volatile", "inline",
	]

	private static let languages: [String: Language] = {
		let swift = Language(
			keywords: [
				"let", "var", "func", "class", "struct", "enum", "protocol", "extension", "import", "return",
				"if", "else", "guard", "switch", "case", "default", "for", "while", "in", "do", "try", "catch",
				"throw", "throws", "async", "await", "actor", "init", "deinit", "self", "super", "static",
				"public", "private", "internal", "fileprivate", "open", "final", "override", "mutating",
				"where", "as", "is", "some", "any", "break", "continue", "defer", "typealias", "associatedtype",
				"inout", "lazy", "weak", "unowned", "nonisolated", "subscript", "operator", "rethrows",
			], sigils: ["@", "#"])
		let js = Language(
			keywords: [
				"const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch",
				"case", "default", "break", "continue", "class", "extends", "new", "this", "super", "import",
				"export", "from", "as", "async", "await", "try", "catch", "finally", "throw", "typeof",
				"instanceof", "in", "of", "delete", "void", "yield", "static", "get", "set", "interface",
				"type", "enum", "implements", "public", "private", "protected", "readonly", "declare",
				"namespace", "abstract", "keyof",
			])
		let python = Language(
			keywords: [
				"def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is",
				"import", "from", "as", "with", "try", "except", "finally", "raise", "pass", "break",
				"continue", "lambda", "yield", "global", "nonlocal", "del", "assert", "async", "await", "match",
				"case",
			],
			literals: ["True", "False", "None"], lineComments: ["#"], blockComment: nil, multilineQuotes: [],
			tripleQuotes: true, sigils: ["@"])
		let go = Language(
			keywords: [
				"func", "package", "import", "var", "const", "type", "struct", "interface", "map", "chan",
				"go", "defer", "return", "if", "else", "for", "range", "switch", "case", "default", "break",
				"continue", "select", "fallthrough", "goto",
			])
		let rust = Language(
			keywords: [
				"fn", "let", "mut", "pub", "use", "mod", "struct", "enum", "impl", "trait", "for", "while",
				"loop", "if", "else", "match", "return", "break", "continue", "as", "in", "ref", "move",
				"static", "const", "unsafe", "async", "await", "dyn", "where", "self", "Self", "crate", "super",
				"type",
			], sigils: [])
		let java = Language(
			keywords: [
				"class", "interface", "enum", "extends", "implements", "public", "private", "protected",
				"static", "final", "abstract", "void", "new", "return", "if", "else", "for", "while", "do",
				"switch", "case", "default", "break", "continue", "try", "catch", "finally", "throw", "throws",
				"import", "package", "this", "super", "instanceof", "fun", "val", "var", "when", "object",
				"override", "data", "sealed", "suspend", "companion", "int", "long", "double", "float",
				"boolean", "char", "byte", "short",
			], sigils: ["@"])
		let c = Language(keywords: cLike.union(["class", "namespace", "using", "template", "typename", "new", "delete", "public", "private", "protected", "virtual", "override", "auto", "bool", "this", "try", "catch", "throw", "nullptr", "NULL"]), sigils: ["#"])
		let json = Language(
			literals: ["true", "false", "null"], lineComments: ["//"], blockComment: ("/*", "*/"),
			quotes: ["\""], multilineQuotes: [], colonKeys: true, typesByCapital: false)
		let shell = Language(
			keywords: [
				"if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "in",
				"function", "return", "export", "local", "echo", "cd", "exit", "source", "set", "unset",
				"readonly", "select", "until",
			],
			lineComments: ["#"], blockComment: nil, multilineQuotes: [], sigils: ["$"], typesByCapital: false)
		let sql = Language(
			keywords: [
				"select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set",
				"delete", "create", "table", "alter", "drop", "index", "join", "left", "right", "inner",
				"outer", "full", "on", "as", "group", "by", "order", "having", "limit", "offset", "union",
				"distinct", "case", "when", "then", "else", "end", "in", "is", "like", "between", "exists",
				"primary", "key", "foreign", "references", "default", "with", "returning", "asc", "desc",
				"count", "sum", "avg", "min", "max", "begin", "commit", "rollback", "view", "unique",
			],
			lineComments: ["--"], quotes: ["'", "\""], multilineQuotes: [], caseInsensitive: true,
			typesByCapital: false)
		let yaml = Language(
			literals: ["true", "false", "null", "yes", "no", "on", "off"], lineComments: ["#"],
			blockComment: nil, multilineQuotes: [], colonKeys: true, typesByCapital: false)
		let ruby = Language(
			keywords: [
				"def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for",
				"in", "do", "return", "yield", "begin", "rescue", "ensure", "raise", "require", "include",
				"attr_accessor", "self", "then", "case", "when", "and", "or", "not", "lambda", "proc",
			],
			literals: ["true", "false", "nil"], lineComments: ["#"], blockComment: nil, multilineQuotes: [])
		var table: [String: Language] = [:]
		for name in ["swift"] { table[name] = swift }
		for name in ["js", "javascript", "jsx", "ts", "typescript", "tsx", "mjs", "node"] { table[name] = js }
		for name in ["py", "python", "python3"] { table[name] = python }
		for name in ["go", "golang"] { table[name] = go }
		for name in ["rust", "rs"] { table[name] = rust }
		for name in ["java", "kotlin", "kt", "scala", "csharp", "cs", "dart"] { table[name] = java }
		for name in ["c", "cpp", "c++", "h", "hpp", "cc", "objc", "objective-c", "m"] { table[name] = c }
		for name in ["json", "jsonc", "json5"] { table[name] = json }
		for name in ["sh", "bash", "shell", "zsh", "console", "fish"] { table[name] = shell }
		for name in ["sql", "postgres", "postgresql", "mysql", "sqlite"] { table[name] = sql }
		for name in ["yaml", "yml", "toml"] { table[name] = yaml }
		for name in ["ruby", "rb"] { table[name] = ruby }
		return table
	}()

	/// True when `language` is one this lexer colours.
	public static func supports(_ language: String?) -> Bool {
		guard let language else { return false }
		return languages[language.lowercased().trimmingCharacters(in: .whitespaces)] != nil
	}

	public static func tokens(in code: String, language: String?) -> [SyntaxToken] {
		guard let language, let lang = languages[language.lowercased().trimmingCharacters(in: .whitespaces)]
		else { return [] }
		return lex(Array(code), lang)
	}

	private static func isIdentStart(_ c: Character) -> Bool { c.isLetter || c == "_" || c == "$" }
	private static func isIdent(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" || c == "$" }

	private static func hasPrefix(_ chars: [Character], at i: Int, _ prefix: String) -> Bool {
		let p = Array(prefix)
		guard i + p.count <= chars.count else { return false }
		for k in 0..<p.count where chars[i + k] != p[k] { return false }
		return true
	}

	private static func lex(_ chars: [Character], _ lang: Language) -> [SyntaxToken] {
		var tokens: [SyntaxToken] = []
		var i = 0
		let n = chars.count

		func nextNonSpace(after index: Int) -> Character? {
			var j = index
			while j < n, chars[j] == " " || chars[j] == "\t" { j += 1 }
			return j < n ? chars[j] : nil
		}

		while i < n {
			let c = chars[i]
			if c.isWhitespace { i += 1; continue }

			if let comment = lang.lineComments.first(where: { hasPrefix(chars, at: i, $0) }) {
				// `#` starts a Swift directive or a C preprocessor line, not a comment, where it is a sigil.
				if !(comment == "#" && lang.sigils.contains("#")) {
					var j = i
					while j < n, chars[j] != "\n" { j += 1 }
					tokens.append(SyntaxToken(start: i, end: j, kind: .comment))
					i = j
					continue
				}
			}
			if let block = lang.blockComment, hasPrefix(chars, at: i, block.open) {
				var j = i + block.open.count
				while j < n, !hasPrefix(chars, at: j, block.close) { j += 1 }
				j = min(n, j + block.close.count)
				tokens.append(SyntaxToken(start: i, end: j, kind: .comment))
				i = j
				continue
			}

			if lang.quotes.contains(c) || lang.multilineQuotes.contains(c) {
				var j = i + 1
				let triple = lang.tripleQuotes && hasPrefix(chars, at: i, String(repeating: c, count: 3))
				if triple {
					j = i + 3
					while j < n, !hasPrefix(chars, at: j, String(repeating: c, count: 3)) { j += 1 }
					j = min(n, j + 3)
				} else {
					let multiline = lang.multilineQuotes.contains(c)
					while j < n {
						if chars[j] == "\\" { j += 2; continue }
						if chars[j] == c { j += 1; break }
						if chars[j] == "\n", !multiline { break }
						j += 1
					}
					j = min(n, j)
				}
				let isKey = lang.colonKeys && nextNonSpace(after: j) == ":"
				tokens.append(SyntaxToken(start: i, end: j, kind: isKey ? .property : .string))
				i = j
				continue
			}

			if c.isNumber || (c == "." && i + 1 < n && chars[i + 1].isNumber) {
				var j = i + 1
				while j < n, chars[j].isNumber || chars[j].isLetter || chars[j] == "." || chars[j] == "_" { j += 1 }
				tokens.append(SyntaxToken(start: i, end: j, kind: .number))
				i = j
				continue
			}

			if lang.sigils.contains(c), i + 1 < n, isIdentStart(chars[i + 1]) || chars[i + 1] == "{" {
				var j = i + 1
				while j < n, isIdent(chars[j]) { j += 1 }
				tokens.append(SyntaxToken(start: i, end: j, kind: c == "$" ? .property : .keyword))
				i = j
				continue
			}

			if isIdentStart(c) {
				var j = i + 1
				while j < n, isIdent(chars[j]) { j += 1 }
				let word = String(chars[i..<j])
				let key = lang.caseInsensitive ? word.lowercased() : word
				if lang.keywords.contains(key) {
					tokens.append(SyntaxToken(start: i, end: j, kind: .keyword))
				} else if lang.literals.contains(key) {
					tokens.append(SyntaxToken(start: i, end: j, kind: .literal))
				} else if lang.colonKeys, nextNonSpace(after: j) == ":" {
					tokens.append(SyntaxToken(start: i, end: j, kind: .property))
				} else if lang.typesByCapital, c.isUppercase, word.count > 1, word.contains(where: \.isLowercase) {
					tokens.append(SyntaxToken(start: i, end: j, kind: .type))
				}
				i = j
				continue
			}
			i += 1
		}
		return tokens
	}

	/// The code as attributed text, coloured where the lexer recognised something.
	public static func attributed(_ code: String, language: String?) -> AttributedString {
		let tokens = tokens(in: code, language: language)
		guard !tokens.isEmpty else { return AttributedString(code) }
		let chars = Array(code)
		var result = AttributedString()
		var cursor = 0
		func plain(_ end: Int) {
			if end > cursor { result += AttributedString(String(chars[cursor..<end])) }
		}
		for token in tokens where token.start >= cursor && token.end <= chars.count {
			plain(token.start)
			var piece = AttributedString(String(chars[token.start..<token.end]))
			piece.foregroundColor = color(token.kind)
			result += piece
			cursor = token.end
		}
		plain(chars.count)
		return result
	}

	static func color(_ kind: SyntaxKind) -> Color {
		switch kind {
		case .keyword: MaskinCode.keyword
		case .string: MaskinCode.string
		case .number: MaskinCode.number
		case .comment: MaskinColor.ink4
		case .type: MaskinCode.type
		case .literal: MaskinCode.literal
		case .property: MaskinCode.property
		}
	}
}

/// Highlighted code, remembered by language and text: a thread redraws its rows often and the
/// lexer would otherwise run again for every visible block each time.
enum SyntaxHighlightCache {
	private final class Box: @unchecked Sendable {
		let text: AttributedString
		init(_ text: AttributedString) { self.text = text }
	}

	nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = {
		let cache = NSCache<NSString, Box>()
		cache.countLimit = 200
		return cache
	}()

	/// Past this size code is shown plain: colouring a pasted log is not worth the time.
	private static let colourLimit = 40_000

	static func attributed(_ code: String, language: String?) -> AttributedString {
		guard SyntaxHighlighter.supports(language), code.utf8.count <= colourLimit else {
			return AttributedString(code)
		}
		let key = "\(language ?? "")\u{0}\(code)" as NSString
		if let hit = cache.object(forKey: key) { return hit.text }
		let text = SyntaxHighlighter.attributed(code, language: language)
		cache.setObject(Box(text), forKey: key)
		return text
	}
}
