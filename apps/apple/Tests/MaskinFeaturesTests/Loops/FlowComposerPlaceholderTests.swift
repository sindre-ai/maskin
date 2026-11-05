import Testing

@testable import MaskinFeatures

@MainActor
@Suite("Flow composer words")
struct FlowComposerPlaceholderTests {
	@Test("message mode names the owner it really sends to")
	func messageNamesOwner() {
		#expect(FlowTimelineModel.placeholder(ownerName: "Developer", mode: .message, flowName: "Webinars") == "Message Developer")
	}

	@Test("comment mode says it comments on the flow, even when an owner exists")
	func commentModeSaysComment() {
		#expect(FlowTimelineModel.placeholder(ownerName: "Developer", mode: .comment, flowName: "Webinars") == "Comment on Webinars")
	}

	@Test("a flow with no owner never claims to message anyone")
	func noOwnerComments() {
		#expect(FlowTimelineModel.placeholder(ownerName: nil, mode: .message, flowName: "Webinars") == "Comment on Webinars")
		#expect(FlowTimelineModel.placeholder(ownerName: nil, mode: .comment, flowName: nil) == "Comment on this flow")
	}
}
