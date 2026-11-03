import Testing

@testable import MaskinCore

@Suite("Adaptive metrics")
struct AdaptiveMetricsTests {
	@Test func liveControlsAre64InRegularAnd58InCompact() {
		#expect(LiveMeetingMetrics.controlSize(regularWidth: true) == 64)
		#expect(LiveMeetingMetrics.controlSize(regularWidth: false) == 58)
	}

	@Test func onlyRegularWidthCapsTheControlCluster() {
		#expect(LiveMeetingMetrics.controlsMaxWidth(regularWidth: true) != nil)
		#expect(LiveMeetingMetrics.controlsMaxWidth(regularWidth: false) == nil)
	}

	@Test func minimumWindowIs320By480() {
		#expect(WindowMetrics.minimumWidth == 320 && WindowMetrics.minimumHeight == 480)
	}
}
