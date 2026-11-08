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

	@Test func captionsRunWiderThanTheControlsInRegularWidthOnly() {
		#expect(LiveMeetingMetrics.captionsMaxWidth(regularWidth: true) == 620)
		#expect(LiveMeetingMetrics.captionsMaxWidth(regularWidth: false) == nil)
		#expect(LiveMeetingMetrics.controlsMaxWidth(regularWidth: true) == 520)
	}

	@Test func detailAndThreadShareA720ReadingColumn() {
		#expect(ReadingColumn.maxWidth == 720)
	}

	@Test func minimumWindowIs320By480() {
		#expect(WindowMetrics.minimumWidth == 320 && WindowMetrics.minimumHeight == 480)
	}
}
