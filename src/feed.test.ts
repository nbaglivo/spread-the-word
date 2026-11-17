import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { normalizeFeed, fetchFeed, FeedError } from './feed.ts'

const NOW = new Date('2026-10-15T12:00:00Z')

test('normalizes an RSS feed with content:encoded', () => {
  const entries = normalizeFeed(readFileSync(new URL('../test/fixtures/example-blog.xml', import.meta.url), 'utf-8'), NOW)
  assert.ok(entries.length >= 5)
  const first = entries.find((e) => e.url === 'https://blog.example.dev/posts/first-light.html')
  assert.ok(first)
  assert.equal(first.id, 'https://blog.example.dev/posts/first-light.html')
  assert.equal(first.title, 'First Light')
  assert.match(first.html, /<p>/)
  assert.equal(first.published.toISOString(), '2026-10-11T00:00:00.000Z')
  for (const e of entries) {
    assert.ok(e.url.startsWith('https://'))
    assert.ok(e.html.length > 0)
    assert.ok(!Number.isNaN(e.published.getTime()))
  }
})

test('uses description as summary only when content:encoded exists', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title><link>https://x.dev/</link><description>d</description>
    <item><title>With body</title><link>https://x.dev/a</link><guid>https://x.dev/a</guid><description>A subtitle</description><content:encoded><![CDATA[<p>Body</p>]]></content:encoded></item>
    <item><title>Only description</title><link>https://x.dev/b</link><guid>https://x.dev/b</guid><description>&lt;p&gt;Short&lt;/p&gt;</description></item>
  </channel></rss>`
  const [a, b] = normalizeFeed(rss, NOW)
  assert.equal(a.summary, 'A subtitle')
  assert.equal(a.html, '<p>Body</p>')
  assert.equal(b.summary, null)
  assert.equal(b.html, '<p>Short</p>')
})

test('normalizes Atom', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><id>urn:x</id><updated>2026-01-03T00:00:00Z</updated>
    <entry><id>urn:e1</id><title>Atom post</title><published>2026-01-01T00:00:00Z</published><updated>2026-01-02T00:00:00Z</updated>
      <link rel="alternate" href="https://x.dev/atom-post"/><summary>Sum</summary><content type="html">&lt;p&gt;Hi&lt;/p&gt;</content></entry>
  </feed>`
  const [e] = normalizeFeed(atom, NOW)
  assert.deepEqual(
    { ...e, published: e.published.toISOString(), updated: e.updated.toISOString() },
    { id: 'urn:e1', url: 'https://x.dev/atom-post', title: 'Atom post', summary: 'Sum', html: '<p>Hi</p>', published: '2026-01-01T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z' },
  )
})

test('normalizes JSON Feed, escaping content_text', () => {
  const json = JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 't',
    items: [
      { id: '1', url: 'https://x.dev/1', title: 'One', content_html: '<p>x</p>', summary: 's', date_published: '2026-02-01T00:00:00Z' },
      { id: '2', url: 'https://x.dev/2', content_text: 'a < b', date_published: '2026-02-02T00:00:00Z', date_modified: '2026-02-03T00:00:00Z' },
    ],
  })
  const [one, two] = normalizeFeed(json, NOW)
  assert.equal(one.html, '<p>x</p>')
  assert.equal(one.summary, 's')
  assert.equal(two.title, 'https://x.dev/2')
  assert.equal(two.html, '<p>a &lt; b</p>')
  assert.equal(two.updated.toISOString(), '2026-02-03T00:00:00.000Z')
})

test('falls back to url as id and skips entries without a url', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><link>https://x.dev/</link><description>d</description>
    <item><title>No guid</title><link>https://x.dev/no-guid</link><description>x</description></item>
    <item><title>Nothing to link</title><description>x</description></item>
  </channel></rss>`
  const entries = normalizeFeed(rss, NOW)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'https://x.dev/no-guid')
})

test('handles missing and odd dates without Invalid Date', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><link>https://x.dev/</link><description>d</description>
    <item><link>https://x.dev/a</link><pubDate>Sun, 11 Oct 2026 00:00:00 GMT</pubDate><description>x</description></item>
    <item><link>https://x.dev/b</link><pubDate>not a date</pubDate><description>x</description></item>
    <item><link>https://x.dev/c</link><description>x</description></item>
  </channel></rss>`
  const [a, b, c] = normalizeFeed(rss, NOW)
  assert.equal(a.published.toISOString(), '2026-10-11T00:00:00.000Z')
  assert.equal(b.published.toISOString(), NOW.toISOString())
  assert.equal(c.published.toISOString(), NOW.toISOString())
  assert.equal(c.updated.toISOString(), NOW.toISOString())
})

test('resolves relative links and images against the entry url', () => {
  const rss = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title><link>https://x.dev/</link><description>d</description>
    <item><link>https://x.dev/writing/post.html</link><content:encoded><![CDATA[<p><img src="/img/a.png"> <a href="other.html">o</a> <a href='https://y.dev/z'>z</a> <a href="#top">t</a></p>]]></content:encoded></item>
  </channel></rss>`
  const [e] = normalizeFeed(rss, NOW)
  assert.match(e.html, /src="https:\/\/x\.dev\/img\/a\.png"/)
  assert.match(e.html, /href="https:\/\/x\.dev\/writing\/other\.html"/)
  assert.match(e.html, /href='https:\/\/y\.dev\/z'/)
  assert.match(e.html, /href="#top"/)
})

test('throws FeedError on something that is not a feed', () => {
  assert.throws(() => normalizeFeed('<html><body>nope</body></html>', NOW), FeedError)
  assert.throws(() => normalizeFeed('', NOW), FeedError)
})

test('resolves relative entry urls against the feed url and skips unusable ones', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title><id>urn:x</id><updated>2026-01-03T00:00:00Z</updated>
    <entry><id>urn:rel</id><title>Relative</title><link href="/posts/a/"/><content type="html">&lt;img src="pic.png"&gt;</content></entry>
    <entry><id>urn:bad</id><title>Not web</title><link href="mailto:me@x.dev"/><content type="html">x</content></entry>
  </feed>`
  const entries = normalizeFeed(atom, NOW, new URL('https://x.dev/feed.xml'))
  assert.deepEqual(entries.map((e) => e.url), ['https://x.dev/posts/a/'])
  assert.match(entries[0].html, /src="https:\/\/x\.dev\/posts\/a\/pic\.png"/)
  assert.deepEqual(normalizeFeed(atom, NOW), [])
})

let server: Server
const seen: { url: string; cacheControl: string | undefined }[] = []

async function startServer(): Promise<string> {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', cacheControl: req.headers['cache-control'] })
    if (req.url?.startsWith('/ok')) {
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      res.end('<rss/>')
    } else if (req.url?.startsWith('/big')) {
      res.writeHead(200)
      res.end('x'.repeat(2048))
    } else if (req.url?.startsWith('/slow')) {
      setTimeout(() => res.end('late'), 1000)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}`
}

after(() => server?.close())

test('fetchFeed busts caches and returns the body', async () => {
  const base = await startServer()
  const body = await fetchFeed(new URL(`${base}/ok/feed.xml`))
  assert.equal(body, '<rss/>')
  const request = seen.at(-1)!
  assert.match(request.url, /^\/ok\/feed\.xml\?_=\d+$/)
  assert.equal(request.cacheControl, 'no-cache')
})

test('fetchFeed fails on HTTP errors, size limit and timeout', async () => {
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await assert.rejects(fetchFeed(new URL(`${base}/missing`)), { name: 'FeedError', message: /returned 404/ })
  await assert.rejects(fetchFeed(new URL(`${base}/big`), { maxBytes: 1024 }), { name: 'FeedError', message: /larger than 1024 bytes/ })
  await assert.rejects(fetchFeed(new URL(`${base}/slow`), { timeoutMs: 50 }), { name: 'FeedError' })
})
