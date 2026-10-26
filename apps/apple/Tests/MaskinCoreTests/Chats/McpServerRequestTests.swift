import Foundation
import Testing

@testable import MaskinCore

@Suite("McpServerRequest")
struct McpServerRequestTests {
	private func message(_ metadata: JSONValue?) -> ChatMessage {
		ChatMessage(
			id: "1", conversationID: "c", actorID: "a", actorName: "Infra", author: .agent,
			kind: "message", content: "x", metadata: metadata)
	}

	private let stdio: JSONValue = .object([
		"mcp_server_request": .object([
			"session_id": .string("s"), "name": .string("Linear"), "hint": .string("To read your issues."),
			"command": .string("npx"), "args": .array([.string("-y"), .string("@linear/mcp-server")]),
			"env": .object(["REGION": .string("eu")]), "secret_env": .array([.string("LINEAR_API_KEY")]),
		])
	])

	@Test func readsTheRequestFromMessageMetadata() throws {
		let request = try #require(McpServerRequest(message: message(stdio)))
		#expect(request.name == "Linear")
		#expect(request.hint == "To read your issues.")
		#expect(request.target == "npx -y @linear/mcp-server")
		#expect(request.isRemote == false)
		#expect(request.givenValues == ["REGION=eu"])
		#expect(request.secretEnv == ["LINEAR_API_KEY"])
	}

	@Test func readsARemoteServerWithASecretHeader() throws {
		let remote: JSONValue = .object([
			"mcp_server_request": .object([
				"session_id": .string("s"), "name": .string("Notion"), "url": .string("https://mcp.notion.com/mcp"),
				"secret_headers": .array([.string("Authorization")]),
			])
		])
		let request = try #require(McpServerRequest(message: message(remote)))
		#expect(request.isRemote)
		#expect(request.target == "https://mcp.notion.com/mcp")
		#expect(request.secretHeaders == ["Authorization"])
	}

	@Test func ignoresMessagesWithoutACompleteRequest() {
		#expect(McpServerRequest(message: message(nil)) == nil)
		let partial: JSONValue = .object(["mcp_server_request": .object(["session_id": .string("s")])])
		#expect(McpServerRequest(message: message(partial)) == nil)
	}

	@Test func needsEverySecretBeforeItCanBeAdded() throws {
		let request = try #require(McpServerRequest(message: message(stdio)))
		#expect(request.isComplete(env: [:], headers: [:]) == false)
		#expect(request.isComplete(env: ["LINEAR_API_KEY": ""], headers: [:]) == false)
		#expect(request.isComplete(env: ["LINEAR_API_KEY": "lin_123"], headers: [:]))
	}

	@Test func buildsTheServerFromTheAgentsValuesAndTheTypedSecrets() throws {
		let request = try #require(McpServerRequest(message: message(stdio)))
		let server = request.server(env: ["LINEAR_API_KEY": "lin_123"], headers: [:])
		#expect(
			server
				== .object([
					"command": .string("npx"), "args": .array([.string("-y"), .string("@linear/mcp-server")]),
					"env": .object(["REGION": .string("eu"), "LINEAR_API_KEY": .string("lin_123")]),
				]))
	}

	@Test func repliesMatchTheWebCard() throws {
		let request = try #require(McpServerRequest(message: message(stdio)))
		#expect(
			request.addedReply(name: "Linear")
				== "I've added the Linear tool server for you. Carry on with the work. Reply with one short line to say you have it."
		)
		#expect(
			request.declinedReply
				== "Not now: please don't add the Linear tool server yet. Carry on without it, or tell me what you need instead."
		)
	}

	@Test func aHelpersRequestIsAnsweredThroughItsSession() throws {
		let helper: JSONValue = .object([
			"mcp_server_request": .object([
				"session_id": .string("s"), "name": .string("Linear"), "command": .string("npx"),
				"reply_to_session": .bool(true),
			])
		])
		let request = try #require(McpServerRequest(message: message(helper)))
		#expect(request.replyToSession)
		#expect(request.addedReply(name: "Linear") == "I've added the Linear tool server for you. Carry on with the work.")
	}
}
