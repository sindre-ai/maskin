import Foundation
import Testing

@testable import MaskinCore

@Suite("Mini-app HTML for a loop view")
struct MiniAppHTMLViewTests {
	private let policy = MiniAppHTML.cspMeta
	private let dnsOff = #"<meta http-equiv="x-dns-prefetch-control" content="off">"#

	private func count(_ needle: String, in text: String) -> Int {
		text.components(separatedBy: needle).count - 1
	}

	@Test("the policy goes right after head, before any of the page's scripts")
	func afterHead() {
		let page = MiniAppHTML.prepareView(
			"<!doctype html><html><head><title>t</title><script>run()</script></head><body></body></html>")
		let policyAt = page.range(of: policy)!.lowerBound
		#expect(page.range(of: "<head>")!.upperBound <= policyAt)
		#expect(policyAt < page.range(of: "<title>")!.lowerBound)
		#expect(policyAt < page.range(of: "<script>")!.lowerBound)
		#expect(count(policy, in: page) == 1)
		#expect(count(dnsOff, in: page) == 1)
	}

	@Test("a head the page writes inside a script, a comment or a code block is not the head")
	func fakeHeads() {
		let html =
			#"<!doctype html><!-- <head> --><script>var s = "<head>";</script><pre><head></pre><head lang="en"><title>x</title></head><body></body>"#
		let page = MiniAppHTML.prepareView(html)
		let policyAt = page.range(of: policy)!.lowerBound
		#expect(page.range(of: #"<head lang="en">"#)!.upperBound == policyAt)
	}

	@Test("a > inside a quoted attribute does not end the tag")
	func quotedAttribute() {
		let page = MiniAppHTML.prepareView(#"<head data-x="a>b"><title>x</title></head>"#)
		#expect(page.hasPrefix(#"<head data-x="a>b">"#))
		#expect(page.range(of: policy)!.lowerBound == page.range(of: #"<head data-x="a>b">"#)!.upperBound)
	}

	@Test("without a head the policy follows the doctype, else comes before body, else first")
	func fallbacks() {
		let doctype = MiniAppHTML.prepareView("<!DOCTYPE html><p>hi</p>")
		#expect(doctype.hasPrefix("<!DOCTYPE html>" + dnsOff))
		let body = MiniAppHTML.prepareView("<p>a</p><body><p>hi</p></body>")
		#expect(body.range(of: policy)!.upperBound <= body.range(of: "<body>")!.lowerBound)
		#expect(body.hasPrefix("<p>a</p>"))
		let bare = MiniAppHTML.prepareView("<p>hi</p>")
		#expect(bare.hasPrefix(dnsOff + policy))
	}

	@Test("a policy, refresh or DNS prefetch tag the page brought is removed")
	func strips() {
		let html = """
			<head>
			<meta http-equiv="Content-Security-Policy" content="default-src *">
			<META HTTP-EQUIV=refresh CONTENT="0;url=https://x.test">
			<meta http-equiv="x-dns-prefetch-control" content="on">
			<title>x</title></head>
			"""
		let page = MiniAppHTML.prepareView(html)
		#expect(count("Content-Security-Policy", in: page) == 1)
		#expect(!page.lowercased().contains("refresh"))
		#expect(!page.contains(#"content="on""#))
		#expect(count("x-dns-prefetch-control", in: page) == 1)
		#expect(page.contains("<title>x</title>"))
	}

	@Test("text outside the tags is kept as it was, accents and emoji included")
	func keepsText() {
		let page = MiniAppHTML.prepareView("<head></head><body><h1>Fødselsdag 🎉 på 7 dage</h1></body>")
		#expect(page.contains("<h1>Fødselsdag 🎉 på 7 dage</h1>"))
	}

	@Test("an unclosed script or comment leaves the policy first rather than inside it")
	func unclosed() {
		let page = MiniAppHTML.prepareView("<script>var x = 1; <head>")
		#expect(page.hasPrefix(dnsOff + policy))
	}
}
