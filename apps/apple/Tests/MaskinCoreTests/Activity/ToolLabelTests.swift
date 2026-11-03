import Foundation
import Testing

@testable import MaskinCore

private func input(_ json: String) -> JSONValue {
	try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
}

@Suite("ToolLabel")
struct ToolLabelTests {
	@Test("file tools name the file, not the path, and keep the path as detail")
	func files() {
		let read = ToolLabel.describe(name: "Read", input: input(#"{"file_path":"/a/b/Thread.swift"}"#))
		#expect(read.label == "Read Thread.swift")
		#expect(read.detail == "/a/b/Thread.swift")
		#expect(read.category == .read)
		#expect(ToolLabel.describe(name: "Edit", input: input(#"{"file_path":"/x/Y.ts"}"#)).label == "Edited Y.ts")
		#expect(ToolLabel.describe(name: "Write", input: input(#"{"file_path":"/x/Y.ts"}"#)).label == "Wrote Y.ts")
	}

	@Test("a shell call uses its description, else the command's first line, and keeps the command")
	func shell() {
		let described = ToolLabel.describe(
			name: "Bash", input: input(#"{"command":"pnpm test","description":"Run the tests"}"#))
		#expect(described.label == "Run the tests")
		#expect(described.detail == "pnpm test")
		#expect(described.category == .run)
		let bare = ToolLabel.describe(name: "Bash", input: input(#"{"command":"ls -la\nwc -l"}"#))
		#expect(bare.label == "Ran ls -la")
	}

	@Test("search and web tools quote what they looked for")
	func searches() {
		#expect(ToolLabel.describe(name: "Grep", input: input(#"{"pattern":"liveTurn"}"#)).label == "Searched for “liveTurn”")
		#expect(ToolLabel.describe(name: "WebFetch", input: input(#"{"url":"https://example.com/a"}"#)).label == "Fetched example.com")
		#expect(ToolLabel.describe(name: "WebSearch", input: input(#"{"query":"swift"}"#)).category == .web)
	}

	@Test("Maskin MCP writes read as what they made, whichever server prefix they carry")
	func maskin() {
		let created = ToolLabel.describe(
			name: "mcp__maskin__create_objects",
			input: input(#"{"nodes":[{"$id":"a","type":"task","title":"Fix login"}]}"#))
		#expect(created.label == "Created task “Fix login”")
		#expect(created.category == .create)
		let many = ToolLabel.describe(
			name: "mcp__claude_ai_maskin__create_objects",
			input: input(#"{"nodes":[{"type":"task","title":"A"},{"type":"bet","title":"B"}]}"#))
		#expect(many.label == "Created 2 objects")
		#expect(ToolLabel.describe(name: "mcp__maskin__search_objects", input: input(#"{"query":"billing"}"#)).label == "Searched Maskin for “billing”")
		#expect(ToolLabel.describe(name: "mcp__maskin__update_objects", input: input(#"{"updates":[{"id":"x","title":"Ship it"}]}"#)).label == "Updated object “Ship it”")
	}

	@Test("the conversation reply tool is a reply step")
	func reply() {
		let d = ToolLabel.describe(name: "mcp__maskin__post_conversation_message", input: input(#"{"content":"hi"}"#))
		#expect(d.label == "Replied to the conversation")
		#expect(d.category == .reply)
	}

	@Test("an unknown tool is humanized and never shows an id")
	func fallback() {
		let d = ToolLabel.describe(
			name: "mcp__linear__list_issues",
			input: input(#"{"team_id":"7d444840-9dc0-11d1-b245-5ffdce74fad2","state":"open"}"#))
		#expect(d.label == "Used list issues")
		#expect(d.detail == "state: open")
		let idOnly = ToolLabel.describe(name: "mcp__x__get_thing", input: input(#"{"id":"7d444840-9dc0-11d1-b245-5ffdce74fad2"}"#))
		#expect(idOnly.detail == "via x")
	}

	@Test("tool search and the integration lookups read as plain actions, not raw tool names")
	func plainNames() {
		let search = ToolLabel.describe(name: "ToolSearch", input: input(#"{"query":"gmail"}"#))
		#expect(search.label == "Looked for a tool")
		#expect(search.detail == "gmail")
		let providers = ToolLabel.describe(name: "mcp__maskin__list_integration_providers", input: input("{}"))
		#expect(providers.label == "Checked connected integrations")
		#expect(providers.category == .read)
	}
}
