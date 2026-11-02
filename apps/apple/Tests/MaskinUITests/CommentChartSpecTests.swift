import Testing

@testable import MaskinUI

@Suite("CommentChartSpec")
struct CommentChartSpecTests {
	@Test func parsesABarChart() {
		let source = #"{"type":"bar","x":"week","series":["clicks"],"data":[{"week":"W1","clicks":120},{"week":"W2","clicks":165}],"caption":"+38%"}"#
		guard case .chart(let spec) = CommentChartSpec.parse(source) else { Issue.record("not a chart"); return }
		#expect(spec.kind == .bar)
		#expect(spec.points.map(\.value) == [120, 165])
		#expect(spec.caption == "+38%")
	}

	@Test func anEmptyFenceDrawsNothing() {
		#expect(CommentChartSpec.parse("  \n") == .empty)
	}

	@Test func aTruncatedFenceSaysItIsIncomplete() {
		#expect(CommentChartSpec.parse(#"{"type":"bar","x":"#) == .failed("the chart data is incomplete or malformed"))
	}

	@Test func anUnknownTypeFails() {
		guard case .failed = CommentChartSpec.parse(#"{"type":"pie","x":"a","series":["b"],"data":[]}"#) else {
			Issue.record("expected failure"); return
		}
	}

	@Test func skipsRowsWithoutANumber() {
		let source = #"{"type":"line","x":"d","series":["v"],"data":[{"d":"a","v":1},{"d":"b","v":"x"}]}"#
		guard case .chart(let spec) = CommentChartSpec.parse(source) else { Issue.record("not a chart"); return }
		#expect(spec.points.count == 1)
	}
}
