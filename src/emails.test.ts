import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PostRow } from './store.ts'
import { TEST_CONFIG } from '../test/fake-remote.ts'
import {
  confirmationEmail,
  confirmUrl,
  excerpt,
  expiredLinkPage,
  formatDate,
  newPostEmail,
  unsubscribePage,
  unsubscribeUrl,
} from './emails.ts'

const site = TEST_CONFIG.sites[0]!

function post(overrides: Partial<PostRow> = {}): PostRow {
  return {
    siteId: site.id,
    entryId: 'e1',
    slug: 'tom',
    title: 'Tom & Jerry <3',
    summary: 'It&#8217;s here',
    html: '<p>body</p>',
    url: 'https://innermonologue.test/posts/tom/',
    published: '2026-11-03T23:30:00Z',
    updated: '2026-11-03T23:30:00Z',
    contentHash: 'h',
    deletedAt: null,
    pendingActivity: null,
    ...overrides,
  } as PostRow
}

describe('excerpt', () => {
  it('prefers the summary and falls back to html', () => {
    assert.equal(excerpt({ summary: 'Hello', html: '<p>Other</p>' }), 'Hello')
    assert.equal(excerpt({ summary: '', html: '<p>Other</p>' }), 'Other')
    assert.equal(excerpt({ summary: null, html: '<p>Other</p>' }), 'Other')
  })

  it('strips tags, decodes entities and collapses whitespace', () => {
    const html = '<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; f&#8217;s&#x2019;&nbsp;g</p>\n\n<p>  h  </p>'
    assert.equal(excerpt({ summary: null, html }), 'a & b <c> "d" \'e\' f’s’ g h')
  })

  it('cuts long text at the last space and appends an ellipsis', () => {
    const text = 'word '.repeat(100)
    const out = excerpt({ summary: text, html: '' })
    assert.ok(out.endsWith('…'))
    assert.ok(out.length <= 281)
    assert.ok(!out.slice(0, -1).endsWith(' '))
    assert.equal(excerpt({ summary: 'x'.repeat(280), html: '' }), 'x'.repeat(280))
  })
})

describe('formatDate', () => {
  it('formats in UTC', () => {
    assert.equal(formatDate('2026-11-03T23:30:00Z'), '3 Nov 2026')
  })
})

describe('urls', () => {
  it('encode the token', () => {
    assert.equal(confirmUrl(TEST_CONFIG, 'inner-monologue', 'a b&c'), 'https://ap.test/sites/inner-monologue/confirm?token=a%20b%26c')
    assert.equal(unsubscribeUrl(TEST_CONFIG, 'inner-monologue', 'a/b'), 'https://ap.test/sites/inner-monologue/unsubscribe?token=a%2Fb')
  })
})

describe('newPostEmail', () => {
  const unsub = 'https://ap.test/sites/inner-monologue/unsubscribe?token=t&x=1'
  const mail = newPostEmail(site, post(), unsub)

  it('renders subject and text', () => {
    assert.equal(mail.subject, 'Tom & Jerry <3')
    assert.ok(mail.text.includes('It’s here'))
    assert.ok(mail.text.includes('https://innermonologue.test/posts/tom/'))
    assert.ok(mail.text.includes('Keep reading'))
    assert.ok(mail.text.includes(unsub))
  })

  it('renders escaped html', () => {
    assert.ok(mail.html.includes('Tom &amp; Jerry &lt;3'))
    assert.ok(!mail.html.includes('&amp;amp;'))
    assert.ok(mail.html.includes('The Open Inner Monologue'))
    assert.ok(mail.html.includes('Keep reading →'))
    assert.ok(mail.html.includes('https://innermonologue.test/posts/tom/'))
    assert.ok(mail.html.includes("You're getting this because you subscribed at innermonologue.test"))
    assert.ok(mail.html.includes('token=t&amp;x=1'))
    assert.ok(mail.html.includes('#faf8f4'))
  })
})

describe('confirmationEmail', () => {
  const url = 'https://ap.test/sites/inner-monologue/confirm?token=abc'
  const mail = confirmationEmail(site, url)

  it('renders copy and link', () => {
    assert.equal(mail.subject, 'Confirm your subscription to The Open Inner Monologue')
    assert.ok(mail.html.includes("One click and you're in"))
    assert.ok(mail.html.includes('Confirm my subscription'))
    assert.ok(mail.html.includes(url))
    assert.ok(mail.html.includes('The link expires in 48 hours.'))
    assert.ok(mail.text.includes(url))
  })
})

describe('pages', () => {
  it('renders the unsubscribe form', () => {
    const action = 'https://ap.test/sites/inner-monologue/unsubscribe?token=a&b'
    const page = unsubscribePage(site, action)
    assert.ok(page.includes('<form method="post" action="https://ap.test/sites/inner-monologue/unsubscribe?token=a&amp;b">'))
    assert.ok(page.includes('Unsubscribe from The Open Inner Monologue?'))
    assert.match(page, /<button[^>]*>Unsubscribe<\/button>/)
  })

  it('renders the expired link page', () => {
    const page = expiredLinkPage(site)
    assert.ok(page.includes('This link has expired or was already used.'))
    assert.ok(page.includes('href="https://innermonologue.test/"'))
  })
})
