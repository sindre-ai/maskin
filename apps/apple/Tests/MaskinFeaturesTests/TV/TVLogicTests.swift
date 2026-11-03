import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("TV logic")
struct TVLogicTests {
	@Test func questionsGetYesNoChips() {
		#expect(TVQuickReplies.chips(lastMessage: "Send the quote to Northwind?") == ["Yes", "No", "Tell me more"])
	}

	@Test func statementsAndEmptyThreadsGetTheirOwnChips() {
		#expect(TVQuickReplies.chips(lastMessage: "Done.") == ["Thanks", "Got it", "Show me"])
		#expect(TVQuickReplies.chips(lastMessage: nil).count == 3)
	}

	@Test func understoodAsIsNilForAnEmptyQuery() {
		#expect(TVSearchGuide.understoodAs(query: "  ", sections: []) == nil)
	}

	@Test func understoodAsSaysWhenNothingMatches() {
		let line = TVSearchGuide.understoodAs(query: "zzz", sections: [])
		#expect(line?.contains("Nothing") == true)
	}

	@Test func profileRowsSplitIntoWorkspaceAndYou() {
		#expect(TVProfileRow.rows(in: .workspace).map(\.title) == ["Agents", "Marketplace", "Artefacts"])
		#expect(TVProfileRow.rows(in: .you).map(\.title) == ["Settings", "Autonomy"])
	}

	@Test func confirmCopyFallsBackWhenTheOptionHasNoConsequences() {
		let option = DecisionOption(label: "Send", consequences: [], recommended: false, destructive: true)
		#expect(TVConfirmCopy.message(for: option).contains("can't be undone"))
	}

	@Test func handoffLinkIsTheObjectDeepLink() {
		let handoff = TVHandoff(workspaceId: "w1", objectId: "o1", title: "Northwind")
		#expect(DeepLink(url: handoff.url) == .object(workspaceId: "w1", id: "o1"))
		#expect(handoff.makeActivity().isEligibleForHandoff)
	}
}

@Suite("TV decision age")
struct TVDecisionAgeTests {
	@Test func tagsOnlyOldDecisions() {
		let now = Date()
		#expect(TVDecisionAge.heldTag(since: now.addingTimeInterval(-3600), now: now) == nil)
		#expect(TVDecisionAge.heldTag(since: now.addingTimeInterval(-30 * 3600), now: now) == "held 1d")
		#expect(TVDecisionAge.heldTag(since: now.addingTimeInterval(-50 * 3600), now: now) == "held 2d")
	}
}

@Suite("TVCardOptions")
struct TVCardOptionsTests {
	@Test func recommendedLeadsAndRestCollapse() {
		let s = TVCardOptions.summary(labels: ["A", "B", "C"], recommended: "B")
		#expect(s.primary == "B" && s.more == 2)
	}
	@Test func fallsBackToFirst() {
		let s = TVCardOptions.summary(labels: ["A", "B"], recommended: nil)
		#expect(s.primary == "A" && s.more == 1)
		#expect(TVCardOptions.summary(labels: [], recommended: nil).more == 0)
	}
}

// MARK: - Device-code sign-in

private actor ScriptedSource: TVDeviceCodeSource {
	var prompts: [TVDeviceCodePrompt]
	var outcomes: [TVDeviceCodeOutcome]
	/// Polls that throw before the scripted outcomes are used.
	var pollErrors: [TVDeviceCodeError] = []
	func failNextPolls(_ errors: [TVDeviceCodeError]) { pollErrors = errors }
	private(set) var starts = 0
	private(set) var polled: [String] = []

	init(prompts: [TVDeviceCodePrompt], outcomes: [TVDeviceCodeOutcome]) {
		self.prompts = prompts
		self.outcomes = outcomes
	}

	func start() async throws -> TVDeviceCodePrompt {
		starts += 1
		guard !prompts.isEmpty else { throw TVDeviceCodeError("Out of codes") }
		return prompts.removeFirst()
	}

	func poll(userCode: String) async throws -> TVDeviceCodeOutcome {
		polled.append(userCode)
		if !pollErrors.isEmpty { throw pollErrors.removeFirst() }
		return outcomes.isEmpty ? .pending : outcomes.removeFirst()
	}
}

private func prompt(_ code: String, lifetime: TimeInterval = 600, from start: Date) -> TVDeviceCodePrompt {
	TVDeviceCodePrompt(
		userCode: code, verificationURL: URL(string: "https://maskin.io/tv")!,
		expiresAt: start.addingTimeInterval(lifetime), pollInterval: 5)
}

@Suite("TV device-code sign-in")
struct TVDeviceCodeTests {
	@Test func promptShowsTheAddressWithoutTheScheme() {
		#expect(prompt("BCDF-2345", from: Date()).verificationLabel == "maskin.io/tv")
	}

	@MainActor
	@Test func pollsUntilApprovedThenHandsOverTheSession() async {
		let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)
		let login = LoginResult(apiKey: "ank_x", actorId: "a", name: "Sebastian", email: nil, workspaceId: "w")
		let source = ScriptedSource(prompts: [prompt("BCDF-2345", from: t0)], outcomes: [.pending, .approved(login)])
		let box = LoginBox()
		let store = TVDeviceCodeStore(source: source, now: { t0 }, sleep: { _ in }) { box.value = $0 }
		await store.run()
		#expect(box.value == login)
		#expect(await source.polled == ["BCDF-2345", "BCDF-2345"])
	}

	@MainActor
	@Test func askForAFreshCodeWhenOneExpires() async {
		let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)
		let login = LoginResult(apiKey: "ank_x", actorId: "a", name: "S", email: nil, workspaceId: nil)
		let source = ScriptedSource(
			prompts: [prompt("AAAA-2222", from: t0), prompt("BBBB-3333", from: t0)], outcomes: [.expired, .approved(login)])
		let box = LoginBox()
		let store = TVDeviceCodeStore(source: source, now: { t0 }, sleep: { _ in }) { box.value = $0 }
		await store.run()
		#expect(await source.starts == 2)
		#expect(box.value == login)
	}

	@MainActor
	@Test func aRefusedCodeStopsWithoutSigningIn() async {
		let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)
		let source = ScriptedSource(prompts: [prompt("BCDF-2345", from: t0)], outcomes: [.denied])
		let box = LoginBox()
		let store = TVDeviceCodeStore(source: source, now: { t0 }, sleep: { _ in }) { box.value = $0 }
		await store.run()
		#expect(box.value == nil)
		#expect(store.phase == .denied)
	}

	@MainActor
	@Test func aWifiBlipDuringPollingDoesNotCostTheCode() async {
		let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)
		let login = LoginResult(apiKey: "ank_x", actorId: "a", name: "S", email: nil, workspaceId: nil)
		let source = ScriptedSource(prompts: [prompt("BCDF-2345", from: t0)], outcomes: [.approved(login)])
		await source.failNextPolls(Array(repeating: TVDeviceCodeError("offline", isTransient: true), count: 2))
		let box = LoginBox()
		let store = TVDeviceCodeStore(source: source, now: { t0 }, sleep: { _ in }) { box.value = $0 }
		await store.run()
		#expect(box.value == login)
		#expect(await source.starts == 1)
	}

	@MainActor
	@Test func manyFailedPollsInARowGiveUp() async {
		let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)
		let source = ScriptedSource(prompts: [prompt("BCDF-2345", from: t0)], outcomes: [])
		await source.failNextPolls(
			Array(repeating: TVDeviceCodeError("offline", isTransient: true), count: TVDeviceCodeStore.maxPollFailures))
		let store = TVDeviceCodeStore(source: source, now: { t0 }, sleep: { _ in }) { _ in }
		await store.run()
		#expect(store.phase == .failed("offline"))
	}

	@MainActor
	@Test func aPollErrorThatIsNotTransientStopsAtOnce() async {
		let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)
		let source = ScriptedSource(prompts: [prompt("BCDF-2345", from: t0)], outcomes: [])
		await source.failNextPolls([TVDeviceCodeError("bad reply")])
		let store = TVDeviceCodeStore(source: source, now: { t0 }, sleep: { _ in }) { _ in }
		await store.run()
		#expect(store.phase == .failed("bad reply"))
		#expect(await source.polled.count == 1)
	}

	@MainActor
	@Test func approvedButUnsavableShowsAnError() async {
		struct Refused: Error {}
		let t0 = Date(timeIntervalSinceReferenceDate: 800_000_000)
		let login = LoginResult(apiKey: "ank_x", actorId: "a", name: "S", email: nil, workspaceId: nil)
		let source = ScriptedSource(prompts: [prompt("BCDF-2345", from: t0)], outcomes: [.approved(login)])
		let store = TVDeviceCodeStore(source: source, now: { t0 }, sleep: { _ in }) { _ in throw Refused() }
		await store.run()
		if case .failed = store.phase {} else { Issue.record("expected a failure") }
	}

	@MainActor
	@Test func aFailedStartSaysSoPlainly() async {
		let source = ScriptedSource(prompts: [], outcomes: [])
		let store = TVDeviceCodeStore(source: source, sleep: { _ in }) { _ in }
		await store.run()
		#expect(store.phase == .failed("Out of codes"))
	}

	@Test func liveSourceKeepsTheDeviceCodeAndMapsTheApproval() async throws {
		let responses = LockedQueue<(Data, Int)>([
			(Data(#"{"device_code":"secret","user_code":"BCDF2345","verification_uri":"https://maskin.io/tv","verification_uri_complete":"https://maskin.io/tv?code=BCDF2345","expires_in":600,"interval":5}"#.utf8), 201),
			(Data(#"{"status":"pending","interval":5}"#.utf8), 200),
			(Data(#"{"status":"approved","actor":{"id":"a1","type":"human","name":"Sebastian","email":"s@x.io","api_key":"ank_k","workspace_id":"w1"}}"#.utf8), 200),
		])
		let sent = LockedQueue<String>([])
		let source = APITVDeviceCodeSource(baseURL: URL(string: "https://api.test")!, send: { request in
			sent.append(String(decoding: request.httpBody ?? Data(), as: UTF8.self))
			return responses.next()!
		})
		let shown = try await source.start()
		#expect(shown.userCode == "BCDF-2345")
		#expect(try await source.poll(userCode: shown.userCode) == .pending)
		let outcome = try await source.poll(userCode: shown.userCode)
		#expect(outcome == .approved(LoginResult(apiKey: "ank_k", actorId: "a1", name: "Sebastian", email: "s@x.io", workspaceId: "w1")))
		// Three requests: start, then two token polls. Only the polls carry the device code.
		#expect(sent.all.count == 3)
		#expect(sent.all.first?.contains("secret") == false)
		#expect(sent.all.dropFirst().allSatisfy { $0.contains("secret") })
	}
}

private final class LoginBox { var value: LoginResult? }

private final class LockedQueue<T: Sendable>: @unchecked Sendable {
	private let lock = NSLock()
	private var items: [T]
	private var log: [T] = []
	init(_ items: [T]) { self.items = items }
	func next() -> T? { lock.withLock { items.isEmpty ? nil : items.removeFirst() } }
	func append(_ item: T) { lock.withLock { log.append(item) } }
	var all: [T] { lock.withLock { log } }
}
