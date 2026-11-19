import Testing

@testable import MaskinFeatures

@Suite("DictationButton")
struct DictationButtonTests {
	/// The thread reply mic called start without the flag, so it always used the phone's recogniser.
	@Test func dictatesThroughTheServer() {
		#expect(DictationButton.usesServer)
	}
}
