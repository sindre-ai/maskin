import Testing

@testable import MaskinCore

@Suite("MiniAppHTML.needsNetwork")
struct MiniAppHTMLNetworkTests {
	@Test("a Tailwind-from-a-CDN page needs the network")
	func cdnScript() {
		let head = """
			<head><link rel="preconnect" href="https://fonts.googleapis.com" />
			<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk" />
			<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script></head>
			"""
		#expect(MiniAppHTML.needsNetwork("<html>\(head)<body class=\"flex\">x</body></html>"))
	}

	@Test("a remote stylesheet needs the network, whatever the attribute order")
	func remoteStylesheet() {
		#expect(MiniAppHTML.needsNetwork(#"<link href="https://example.com/app.css" rel="stylesheet">"#))
		#expect(MiniAppHTML.needsNetwork(#"<link rel=stylesheet href=//example.com/app.css>"#))
	}

	@Test("web fonts alone do not, the page still lays out")
	func fontsOnly() {
		#expect(!MiniAppHTML.needsNetwork(#"<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">"#))
	}

	@Test("a self-contained page does not")
	func selfContained() {
		#expect(!MiniAppHTML.needsNetwork("<style>body{margin:0}</style><script>var a=1</script><p>hi</p>"))
		#expect(!MiniAppHTML.needsNetwork(#"<a href="https://example.com">link</a>"#))
	}
}
