import Testing

@testable import MaskinCore

@Suite("HomeScreenQuickAction", .serialized)
@MainActor
struct HomeScreenQuickActionTests {
	@Test func shortcutTypesMatchTheStaticItemsInProjectYml() {
		#expect(HomeScreenQuickAction(shortcutType: "io.maskin.app.quick-action.new-message") == .newMessage)
		#expect(HomeScreenQuickAction(shortcutType: "io.maskin.app.quick-action.for-you") == .forYou)
	}

	@Test func anUnknownTypeIsNotAnAction() {
		#expect(HomeScreenQuickAction(shortcutType: "io.maskin.app.quick-action.other") == nil)
		#expect(HomeScreenQuickAction(shortcutType: "") == nil)
	}

	@Test func aTapBeforeTheAppIsReadyWaitsAndIsReplayedOnce() {
		HomeScreenQuickActionRelay.reset()
		HomeScreenQuickActionRelay.perform(.newMessage)
		#expect(HomeScreenQuickActionRelay.pending == .newMessage)

		var received: [HomeScreenQuickAction] = []
		HomeScreenQuickActionRelay.attach { received.append($0) }
		#expect(received == [.newMessage])
		#expect(HomeScreenQuickActionRelay.pending == nil)
		HomeScreenQuickActionRelay.reset()
	}

	@Test func aTapWhileTheAppIsRunningGoesStraightThrough() {
		HomeScreenQuickActionRelay.reset()
		var received: [HomeScreenQuickAction] = []
		HomeScreenQuickActionRelay.attach { received.append($0) }
		HomeScreenQuickActionRelay.perform(.forYou)
		HomeScreenQuickActionRelay.perform(.newMessage)
		#expect(received == [.forYou, .newMessage])
		#expect(HomeScreenQuickActionRelay.pending == nil)
		HomeScreenQuickActionRelay.reset()
	}
}
