import Testing

@testable import MaskinFeatures

@Suite struct ShellComposeTests {
	@Test func startersAreLoopBetAndAgentInOrder() {
		#expect(ShellCompose.starters.map(\.title) == ["New loop", "New bet", "Hire an agent"])
	}

	@Test func everyStarterHasAPromptToContinueTyping() {
		for starter in ShellCompose.starters {
			#expect(starter.prompt.hasSuffix(" "))
			#expect(!starter.prompt.trimmingCharacters(in: .whitespaces).isEmpty)
		}
	}

	@Test func shellActionsDefaultToTheSingleShellSearch() {
		let actions = ShellActions()
		#expect(actions.search)
		#expect(actions.new == nil && actions.compose == nil && !actions.live)
	}
}
