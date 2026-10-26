import Foundation
import Testing

@testable import MaskinCore

@Suite("KeychainAccessRequest")
struct KeychainAccessTests {
	private func message(_ metadata: JSONValue?) -> ChatMessage {
		ChatMessage(
			id: "1", conversationID: "c", actorID: "a", actorName: "Infra", author: .agent,
			kind: "message", content: "x", metadata: metadata)
	}

	private let card: JSONValue = .object([
		"keychain_access_request": .object([
			"session_id": .string("s"), "integration_id": .string("i"),
			"credential_name": .string("Google (Mesh Firm)"), "kind": .string("login"),
			"hint": .string("To read the Drive setup."),
		])
	])

	@Test func readsTheRequestFromMessageMetadata() throws {
		let request = try #require(KeychainAccessRequest(message: message(card)))
		#expect(request.credentialName == "Google (Mesh Firm)")
		#expect(request.kind == .login)
		#expect(request.integrationID == "i")
		#expect(request.hint == "To read the Drive setup.")
	}

	@Test func ignoresMessagesWithoutACompleteRequest() {
		#expect(KeychainAccessRequest(message: message(nil)) == nil)
		let partial: JSONValue = .object(["keychain_access_request": .object(["session_id": .string("s")])])
		#expect(KeychainAccessRequest(message: message(partial)) == nil)
	}

	@Test func repliesMatchTheWebCard() throws {
		let request = try #require(KeychainAccessRequest(message: message(card)))
		let vars = "KEYCHAIN_BYO_LOGIN_GOOGLE_MESH_FIRM_USERNAME and KEYCHAIN_BYO_LOGIN_GOOGLE_MESH_FIRM_PASSWORD"
		#expect(
			request.allowedReply(scope: .chat)
				== "I've allowed you to use Google (Mesh Firm) from the Keychain in this chat only. It's in your environment as \(vars). Reply with one short line to say you have it, then carry on."
		)
		#expect(
			request.allowedReply(scope: .always)
				== "I've allowed you to use Google (Mesh Firm) from the Keychain. It's in your environment as \(vars). Reply with one short line to say you have it, then carry on."
		)
	}

	@Test func aHelpersRequestIsAnsweredThroughItsSession() throws {
		let helper: JSONValue = .object([
			"keychain_access_request": .object([
				"session_id": .string("s"), "integration_id": .string("i"),
				"credential_name": .string("Coolify"), "kind": .string("api_key"), "reply_to_session": .bool(true),
			])
		])
		let request = try #require(KeychainAccessRequest(message: message(helper)))
		#expect(request.replyToSession)
		#expect(
			request.allowedReply(scope: .always)
				== "I've allowed you to use Coolify from the Keychain. It's in your environment as KEYCHAIN_BYO_APIKEY_COOLIFY. Carry on with the work."
		)
	}
}

@Suite("KeychainCapture")
struct KeychainCaptureTests {
	@Test func readsTheRequestFromMessageMetadata() throws {
		let metadata: JSONValue = .object([
			"keychain_request": .object([
				"session_id": .string("s"), "kind": .string("login"), "suggested_name": .string("e-conomic"),
			])
		])
		let message = ChatMessage(
			id: "1", conversationID: "c", actorID: "a", actorName: "Infra", author: .agent, kind: "message",
			content: "x", metadata: metadata)
		let request = try #require(KeychainCredentialRequest(message: message))
		#expect(request.kind == .login)
		#expect(request.suggestedName == "e-conomic")
	}

	@Test func envNamesMatchTheServer() {
		#expect(
			KeychainCredentialName.envNames(kind: .login, name: "e-conomic")
				== ["KEYCHAIN_BYO_LOGIN_E_CONOMIC_USERNAME", "KEYCHAIN_BYO_LOGIN_E_CONOMIC_PASSWORD"])
		#expect(KeychainCredentialName.envNames(kind: .apiKey, name: "Coolify") == ["KEYCHAIN_BYO_APIKEY_COOLIFY"])
		#expect(KeychainCredentialName.envNames(kind: .apiKey, name: "🔑").isEmpty)
	}

	@Test func refusesNamesTheServerWouldRefuse() {
		#expect(KeychainCredentialName.problem("Google (Mesh Firm)") == nil)
		#expect(KeychainCredentialName.problem("  ") != nil)
		#expect(KeychainCredentialName.problem("a[b]") != nil)
		#expect(KeychainCredentialName.problem("!!!") != nil)
		#expect(KeychainCredentialName.problem(String(repeating: "a", count: 65)) != nil)
	}

	@Test func failureMessagesNeverEchoTheBody() {
		let body = Data(#"{"error":{"message":"Invalid fields: rawSecret"}}"#.utf8)
		#expect(APIKeychainCaptureSource.failure(status: 400, body: body) == "Couldn't save: Invalid fields: rawSecret")
		#expect(APIKeychainCaptureSource.failure(status: 500, body: body) == "Couldn't save. Try again.")
	}
}

@Suite("Hidden card messages")
struct HiddenCardMessageTests {
	private func message(_ metadata: JSONValue?, thread: Int? = nil) -> ChatMessage {
		ChatMessage(
			id: "1", conversationID: "c", actorID: "a", actorName: "Sebastian", author: .human, kind: "message",
			content: "x", metadata: metadata, threadRootID: thread)
	}

	@Test func aCardNudgeAndAHelperReturnAreHiddenFromTheTimeline() {
		#expect(message(.object(["hidden_from_chat": .bool(true)])).showsInTimeline == false)
		#expect(message(.object(["helper_return": .string("u")])).showsInTimeline == false)
		#expect(message(.object(["mentions": .array([])])).showsInTimeline)
		#expect(message(nil).showsInTimeline)
	}

	@Test func theHiddenMarkerAndCardAnswerGoOnTheWireWithTheApiKeyNames() throws {
		let metadata = ChatSendMetadata(
			hiddenFromChat: true, cardAnswer: ChatCardAnswer(messageID: 7, outcome: .declined))
		let json = try #require(metadata.jsonValue)
		#expect(json["hidden_from_chat"]?.boolValue == true)
		#expect(json["card_answer"]?["message_id"]?.intValue == 7)
		#expect(json["card_answer"]?["outcome"]?.stringValue == "declined")
		#expect(ChatSendMetadata().isEmpty)
		#expect(ChatSendMetadata(hiddenFromChat: false).isEmpty)
	}

	@Test func aDeclineIsReadBackFromTheMessageThatCarriesIt() throws {
		let answer = try #require(
			message(
				.object([
					"hidden_from_chat": .bool(true),
					"card_answer": .object(["message_id": .number(7), "outcome": .string("declined")]),
				])
			).cardAnswer)
		#expect(answer == ChatCardAnswer(messageID: 7, outcome: .declined))
	}
}
