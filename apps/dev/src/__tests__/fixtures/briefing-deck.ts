/**
 * A synthetic briefing deck shaped like the ones agents write: a head that is
 * mostly base64 fonts, one `<section class="slide">` per slide with an `<h2>`,
 * lists, a CSS-grid "table" made of spans, links, `data-notes`, and a script.
 * `fontChars` sets how much base64 sits in the head (the real decks carry ~520k).
 */
export function buildBriefingDeck(opts: { fontChars?: number; deckSource?: string } = {}): string {
	const font = 'QUJD'.repeat(Math.ceil((opts.fontChars ?? 400) / 4)).slice(0, opts.fontChars ?? 400)
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Weekly readout, 27 Oct</title>
<meta name="description" content="What we learned this week">
<style>
@font-face{font-family:'Test Sans';src:url(data:font/ttf;base64,${font}) format('truetype')}
.slide{position:absolute;opacity:0}
</style>
<script type="application/ld+json">{"@type":"Report","name":"Weekly readout"}</script>
${opts.deckSource ? `<script type="text/markdown" id="deck-source">${opts.deckSource}</script>` : ''}
</head>
<body>
<div class="stage">
<section class="slide s1" data-notes="Source: the discovery readouts. Confidence is medium.">
  <div class="chip">What we learned</div>
  <h2 class="t">Plumbing is no moat</h2>
  <ul class="learn">
    <li><span class="tg">Market</span><span class="tx"><b>Vendors ship the teammate layer</b> and its consent rules.</span></li>
    <li><span class="tg">Customers</span><span class="tx">They stall in <a href="https://example.com/setup">setup</a>.</span></li>
  </ul>
  <div class="foot"><span class="nav"><button class="pv" aria-label="Previous slide">&lsaquo;</button><span class="n">1 / 2</span></span></div>
</section>
<section class="slide s2">
  <h2 class="t">Trends</h2>
  <div class="tbl">
    <div class="hr"><span>#</span><span>Trend</span><span>Confidence</span></div>
    <div class="r"><span>1</span><span>Consent is the default</span><span>High</span></div>
  </div>
  <table><thead><tr><th>Who</th><th>Stars</th></tr></thead><tbody><tr><td>Closedloop</td><td>19</td></tr></tbody></table>
  <svg viewBox="0 0 10 10"><text>SVG-ONLY-TEXT</text></svg>
  <img alt="" src="data:image/png;base64,QUJDQUJD">
</section>
</div>
<script>document.querySelector('.stage').addEventListener('click', function () { var SECRET_SCRIPT = 1 })</script>
</body>
</html>`
}
