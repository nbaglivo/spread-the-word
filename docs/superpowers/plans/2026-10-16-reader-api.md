# warmhole Reader API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A site's warmhole account follows other fediverse accounts, keeps what they post (including boosts), and serves it to one private reader (Coffee Companion) through a small bearer-token API.

**Architecture:** Builds on the finished v1 plan (`docs/superpowers/plans/2026-10-15-warmhole.md`). New pure modules normalize remote objects (`objects`) and sanitize their HTML (`content`). `store` gains `actors`, `following` and `items` tables. Fedify inbox listeners in `receive` apply the inbound rules; `following` sends `Follow`/`Undo`. A Hono sub-app (`reader`) is mounted at `/reader/v1` before the Fedify middleware.

**Tech Stack:** As v1, plus `sanitize-html` 2, `htmlparser2` 10, and dev-only `ajv` 8 + `ajv-formats` 3 for the contract test.

**Spec:** `docs/superpowers/specs/2026-10-16-reader-api-design.md`. **Contract:** `docs/reader-api.openapi.json` (the API must match it exactly; Task 7 tests every response against it).

## Global Constraints

- Every v1 global constraint still holds (Node 26, erasable TypeScript, `.ts` imports, `node:test`, comment-free JSON, conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, never push).
- v1 must be fully implemented and green before Task 1. Run `npm test && npm run typecheck` first.
- Reader API path prefix: `/reader/v1`. Routes: `GET /sites/{siteId}/items`, `GET /sites/{siteId}/items/lookup?id=`, `GET|POST|DELETE /sites/{siteId}/following`.
- Reader JSON is snake_case. Every error body is `{ "error": "<message>", "code": "<code>" }`. Every reader response has `Cache-Control: no-store`.
- Bad, missing or misplaced reader token, unknown site and a site without `readerTokenEnv` all answer `401` with `WWW-Authenticate: Bearer realm="warmhole"`.
- Limits: `limit` 1 to 200 (default 50); reader request bodies 4 KB; inbox bodies 1 MB; remote lookups 10 s; 10 failed auths per client per minute; 30 follow requests per site per minute; 2000 follows per site; 256 KB sanitized content, 20 attachments, 50 hashtags, 50 mentions per item.
- Timestamps stored and served as ISO 8601 UTC with milliseconds (`new Date(x).toISOString()`).
- Only sites with a reader token store anything inbound. A site without one behaves exactly like v1.
- Fedify APIs below were written against `@fedify/fedify@2.4` and `@fedify/vocab@2.4`. When a name differs, check `node_modules/@fedify/*/dist/*.d.ts` and use the name it declares; keep the behavior.

## Review Focus

- **Mastodon sends both `content` and `contentMap`**: Fedify exposes them as a plain string plus a `LanguageString`; `language` must come from the tagged one. Test in Task 3.
- **Boost first, original later** (`Announce` then the author's own `Create`): one item, upgraded in place, same `seq`. Test in Task 4 and Task 6.
- **Late `Create` after `Delete`**: the tombstone wins; the post never comes back. Test in Task 4 and Task 6.
- **Paging while items arrive**: no duplicates, no gaps, in both orders; an asc cursor resumes after the last item. Test in Task 4 and Task 7.
- **Shared-inbox delivery with two sites**: stored only for sites that follow the actor with state `accepted` and have a reader token; a personal inbox only for its own site. Test in Task 6.
- **`Accept` that doesn't echo our `Follow` id**: accepted only on that site's own inbox and only while `pending`. Test in Task 5.
- **Hostile HTML**: `javascript:` and protocol-relative links, `on*` attributes, `style`, `iframe`, `svg`. Test in Task 2.
- **Watching a follow in `scripts/logs`**: the operator sees `sent Follow → host` and then `… accepted <site>`, not a raw fragment like `Follows/<uuid>`. Test in Task 9.

---

## File Structure

```
warmhole/
  warmhole.example.json          (modified in Task 8)
  README.md                      (modified in Task 8)
  src/
    config.ts                    (modified in Task 1) readerToken, retentionDays
    content.ts                   sanitize remote HTML, render plain text
    objects.ts                   Fedify object -> ItemDraft; visibility
    store.ts                     (modified in Task 4) actors, following, items
    actors.ts                    actor cache rows, handle via WebFinger, timeouts
    following.ts                 parse accounts, Follow / Undo(Follow)
    receive.ts                   inbox handlers for Accept/Reject/Create/Update/Delete/Announce
    federation.ts                (modified in Tasks 5 and 6) new listeners
    auth.ts                      constant-time token compare, window limiter
    reader.ts                    reader API sub-app
    retention.ts                 pruning, hourly
    logview.ts                   (modified in Task 9) name Follow and Undo
    app.ts                       (modified in Tasks 7 and 8) mount reader, inbox body limit
    server.ts                    (modified in Task 8) wiring
  test/
    fake-remote.ts               (modified in Task 5) followed accounts, objects, webfinger
    items.ts                     drafts, actors and follows for store/reader tests
    contract.ts                  validates bodies against docs/reader-api.openapi.json
```

---

### Task 1: Reader settings in config

**Files:**
- Modify: `src/config.ts`, `test/fake-remote.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  ```ts
  export type SiteConfig = {
    id: string; handle: string; domain: string; feedUrl: URL; name: string
    summary: string | undefined; icon: URL | undefined; syncToken: string; deleteMissing: boolean
    readerToken: string | undefined; retentionDays: number
  }
  ```
  `test/fake-remote.ts` additionally exports `READER_TOKEN: string` and `TEST_CONFIG` gains `readerToken: READER_TOKEN, retentionDays: 30`.

- [ ] **Step 1: Write the failing tests**

In `src/config.test.ts`, add to the end of the first test (`parses a valid config and normalizes handle and domain`):
```ts
  assert.equal(s.readerToken, undefined)
  assert.equal(s.retentionDays, 30)
```

Append:
```ts
const READER = 'r'.repeat(32)

test('reads readerTokenEnv and retentionDays', () => {
  const config = parseConfig(
    { publicUrl: 'https://ap.nbaglivo.dev', sites: [site({ readerTokenEnv: 'READER', retentionDays: 7 })] },
    { ...env, READER },
  )
  assert.equal(config.sites[0].readerToken, READER)
  assert.equal(config.sites[0].retentionDays, 7)
})

test('rejects bad reader settings', () => {
  const at = (overrides: Record<string, unknown>, e: Record<string, string> = { ...env, READER }) =>
    () => parseConfig({ publicUrl: 'https://ap.nbaglivo.dev', sites: [site(overrides)] }, e)
  assert.throws(at({ readerTokenEnv: 'READER' }, env), /sites\[0\]\.readerTokenEnv: environment variable READER is not set/)
  assert.throws(at({ readerTokenEnv: 'READER' }, { ...env, READER: 'short' }), /READER must be at least 32 characters/)
  assert.throws(at({ readerTokenEnv: 'READER' }, { BLOG_TOKEN: READER, READER }), /READER must differ from the sync token/)
  for (const retentionDays of [0, 3651, 1.5, '30', null]) {
    assert.throws(at({ retentionDays }), /sites\[0\]\.retentionDays must be an integer from 1 to 3650/, String(retentionDays))
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/config.test.ts`
Expected: FAIL, `readerToken` is not a property / assertion errors on the new tests.

- [ ] **Step 3: Implement**

In `src/config.ts`, extend the type:
```ts
export type SiteConfig = {
  id: string
  handle: string
  domain: string
  feedUrl: URL
  name: string
  summary: string | undefined
  icon: URL | undefined
  syncToken: string
  deleteMissing: boolean
  readerToken: string | undefined
  retentionDays: number
}
```

In `parseConfig`, after the `deleteMissing` check and before the `return`, add:
```ts
    let readerToken: string | undefined
    const readerEnv = optionalString(entry, 'readerTokenEnv', at)
    if (readerEnv !== undefined) {
      readerToken = env[readerEnv]
      if (!readerToken) throw new ConfigError(`${at}.readerTokenEnv: environment variable ${readerEnv} is not set`)
      if (readerToken.length < 32) throw new ConfigError(`${at}.readerTokenEnv: ${readerEnv} must be at least 32 characters`)
      if (readerToken === syncToken) throw new ConfigError(`${at}.readerTokenEnv: ${readerEnv} must differ from the sync token`)
    }

    const retentionDays = entry.retentionDays === undefined ? 30 : entry.retentionDays
    if (typeof retentionDays !== 'number' || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
      throw new ConfigError(`${at}.retentionDays must be an integer from 1 to 3650`)
    }
```
and change the `return` to:
```ts
    return {
      id, handle, domain, feedUrl, name, summary, icon, syncToken,
      deleteMissing: entry.deleteMissing === true, readerToken, retentionDays,
    }
```

In `test/fake-remote.ts`, add above `TEST_CONFIG`:
```ts
export const READER_TOKEN = 'reader-token-for-tests-0123456789'
```
and add `readerToken: READER_TOKEN, retentionDays: 30,` to the site in `TEST_CONFIG`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (v1 tests included); `tsc` silent.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts test/fake-remote.ts
git commit -m "feat: read reader token and retention from site config

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Sanitizing and plain text

**Files:**
- Create: `src/content.ts`
- Test: `src/content.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export function sanitizeHtml(html: string, base?: URL): string
  export function htmlToText(html: string): string
  export function plainText(value: string | null | undefined): string | null
  ```
  `sanitizeHtml` applies the spec's allowlist, resolving relative URLs against `base`. `htmlToText` renders (already sanitized) HTML as plain text. `plainText` is `htmlToText` for short fields, returning null for empty results.

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install sanitize-html@^2.17.0 htmlparser2@^10.0.0
npm install --save-dev @types/sanitize-html@^2.16.0
```
Expected: `package.json` and `package-lock.json` updated, no errors.

- [ ] **Step 2: Write the failing tests**

`src/content.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText, plainText, sanitizeHtml } from './content.ts'

const base = new URL('https://social.test/users/alice/statuses/1')
const REL = 'rel="nofollow noopener noreferrer"'

test('keeps allowed markup', () => {
  assert.equal(sanitizeHtml('<p>Hi <strong>there</strong>, <em>you</em></p>'), '<p>Hi <strong>there</strong>, <em>you</em></p>')
  assert.equal(sanitizeHtml('<blockquote><p>q</p></blockquote><ul><li>a</li></ul>'), '<blockquote><p>q</p></blockquote><ul><li>a</li></ul>')
})

test('drops scripts, styles, handlers and embeds', () => {
  assert.equal(
    sanitizeHtml('<p onclick="x()" style="color:red" id="a" data-x="1">a</p><script>alert(1)</script><style>p{}</style>'),
    '<p>a</p>',
  )
  assert.equal(sanitizeHtml('<iframe src="https://x.test">fallback</iframe><svg><text>s</text></svg><p>ok</p>'), '<p>ok</p>')
  assert.equal(sanitizeHtml('<p>a<!-- secret --></p>'), '<p>a</p>')
})

test('unwraps unknown elements and keeps their text', () => {
  assert.equal(sanitizeHtml('<div><section><font color="red">hi</font></section></div>'), 'hi')
})

test('rewrites links: safe schemes, resolved, rel forced, classes filtered', () => {
  assert.equal(
    sanitizeHtml('<a href="/tags/coffee" class="mention hashtag status-link" target="_blank">#coffee</a>', base),
    `<a href="https://social.test/tags/coffee" class="mention hashtag" ${REL}>#coffee</a>`,
  )
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>', base), `<a ${REL}>x</a>`)
  assert.equal(sanitizeHtml('<a href="//evil.test/x">x</a>', base), `<a ${REL}>x</a>`)
  assert.equal(sanitizeHtml('<a href="mailto:a@b.test">mail</a>'), `<a href="mailto:a@b.test" ${REL}>mail</a>`)
  assert.equal(
    sanitizeHtml('<span class="h-card" translate="no"><span class="invisible">https://</span></span>'),
    '<span class="h-card"><span class="invisible">https://</span></span>',
  )
})

test('keeps https images only, with numeric sizes', () => {
  assert.equal(
    sanitizeHtml('<img src="https://x.test/a.png" alt="A" width="100" height="big" onerror="x()">'),
    '<img src="https://x.test/a.png" alt="A" width="100" />',
  )
  assert.equal(sanitizeHtml('<p><img src="http://x.test/a.png" alt="A">b</p>'), '<p>b</p>')
  assert.equal(sanitizeHtml('<img src="/a.png">', base), '<img src="https://social.test/a.png" />')
})

test('renders paragraphs, breaks and lists as plain text', () => {
  assert.equal(htmlToText('<p>One</p><p>Two<br>Three</p>'), 'One\n\nTwo\nThree')
  assert.equal(htmlToText('<ul><li>a</li><li>b</li></ul><ol start="3"><li>c</li></ol>'), '- a\n- b\n\n3. c')
  assert.equal(htmlToText('<p>  lots   of\n spaces </p>'), 'lots of spaces')
})

test('renders quotes, pre and images as plain text', () => {
  assert.equal(htmlToText('<blockquote><p>quoted</p><p>more</p></blockquote><p>after</p>'), '> quoted\n>\n> more\n\nafter')
  assert.equal(htmlToText('<pre>  a\n    b</pre>'), '  a\n    b')
  assert.equal(htmlToText('<p>see <img src="https://x.test/a.png" alt="a cat"> and <img src="https://x.test/b.png"></p>'), 'see [a cat] and')
})

test('reads Mastodon links in full and decodes entities', () => {
  assert.equal(
    htmlToText(
      '<p><a href="https://x.test/very/long"><span class="invisible">https://</span><span class="ellipsis">x.test/very</span><span class="invisible">/long</span></a> &amp; more</p>',
    ),
    'https://x.test/very/long & more',
  )
})

test('plainText strips markup and returns null for nothing', () => {
  assert.equal(plainText('Bob <b>Builder</b>'), 'Bob Builder')
  assert.equal(plainText('Food &amp; drink'), 'Food & drink')
  assert.equal(plainText('Food & drink'), 'Food & drink')
  assert.equal(plainText('   '), null)
  assert.equal(plainText(null), null)
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test src/content.test.ts`
Expected: FAIL, `Cannot find module '.../src/content.ts'`.

- [ ] **Step 4: Implement `src/content.ts`**

```ts
import sanitize from 'sanitize-html'
import { Parser } from 'htmlparser2'

const DIGITS = /^\d{1,5}$/
const LINK_SCHEMES = ['http:', 'https:', 'mailto:']
const IMAGE_SCHEMES = ['https:']

function safeUrl(value: string | undefined, base: URL | undefined, schemes: string[]): string | undefined {
  if (!value || value.trim().startsWith('//')) return undefined
  try {
    const url = base ? new URL(value, base) : new URL(value)
    return schemes.includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function digitsOnly(attribs: Record<string, string>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) if (attribs[name] !== undefined && DIGITS.test(attribs[name])) out[name] = attribs[name]
  return out
}

export function sanitizeHtml(html: string, base?: URL): string {
  return sanitize(html, {
    allowedTags: [
      'p', 'br', 'a', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'sup', 'sub', 'img', 'figure', 'figcaption',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
    ],
    allowedAttributes: {
      a: ['href', 'class', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      span: ['class'],
      ol: ['start'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedClasses: { a: ['mention', 'hashtag', 'u-url'], span: ['h-card', 'invisible', 'ellipsis'] },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { a: ['http', 'https', 'mailto'], img: ['https'] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'template', 'noscript', 'textarea', 'option', 'iframe', 'object', 'embed', 'svg', 'math'],
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
    transformTags: {
      a: (tagName, attribs) => {
        const out: Record<string, string> = {}
        const href = safeUrl(attribs.href, base, LINK_SCHEMES)
        if (href) out.href = href
        if (attribs.class) out.class = attribs.class
        out.rel = 'nofollow noopener noreferrer'
        return { tagName, attribs: out }
      },
      img: (tagName, attribs) => {
        const out: Record<string, string> = {}
        const src = safeUrl(attribs.src, base, IMAGE_SCHEMES)
        if (src) out.src = src
        if (attribs.alt) out.alt = attribs.alt
        if (attribs.title) out.title = attribs.title
        return { tagName, attribs: { ...out, ...digitsOnly(attribs, ['width', 'height']) } }
      },
      ol: (tagName, attribs) => ({ tagName, attribs: digitsOnly(attribs, ['start']) }),
      th: (tagName, attribs) => ({ tagName, attribs: digitsOnly(attribs, ['colspan', 'rowspan']) }),
      td: (tagName, attribs) => ({ tagName, attribs: digitsOnly(attribs, ['colspan', 'rowspan']) }),
    },
  })
}

const BLOCKS = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption',
  'table', 'ul', 'ol', 'section', 'article', 'header', 'footer',
])
const VOID = new Set(['br', 'img', 'hr'])

type Frame = { tag: string; out: string; next: number }

function trimBlock(text: string): string {
  return text.replace(/^\n+/, '').replace(/\s+$/, '')
}

export function htmlToText(html: string): string {
  const stack: Frame[] = [{ tag: '', out: '', next: 1 }]
  let pre = 0
  const top = () => stack[stack.length - 1]
  const write = (text: string) => {
    const frame = top()
    if (pre === 0 && (frame.out === '' || frame.out.endsWith('\n'))) text = text.replace(/^ +/, '')
    frame.out += text
  }

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === 'br') {
          top().out = top().out.replace(/ +$/, '') + '\n'
          return
        }
        if (name === 'hr') {
          top().out += '\n\n'
          return
        }
        if (name === 'img') {
          if (attribs.alt) write(`[${attribs.alt}]`)
          return
        }
        if ((name === 'td' || name === 'th') && top().tag === 'tr' && top().out.trim() !== '') write(' | ')
        if (BLOCKS.has(name) || name === 'li' || name === 'tr') {
          if (name === 'pre') pre++
          const start = name === 'ol' && attribs.start && /^\d+$/.test(attribs.start) ? Number(attribs.start) : 1
          stack.push({ tag: name, out: '', next: start })
        }
      },
      ontext(text) {
        write(pre > 0 ? text : text.replace(/\s+/g, ' '))
      },
      onclosetag(name) {
        if (VOID.has(name) || stack.length === 1 || top().tag !== name) return
        const frame = stack.pop()!
        const parent = top()
        if (name === 'pre') {
          pre--
          parent.out += `\n\n${frame.out.replace(/^\n/, '').trimEnd()}\n\n`
        } else if (name === 'li') {
          const prefix = parent.tag === 'ol' ? `${parent.next++}. ` : '- '
          const body = trimBlock(frame.out).replace(/\n{2,}/g, '\n').replace(/\n/g, '\n  ')
          parent.out += `\n${prefix}${body}`
        } else if (name === 'tr') {
          parent.out += `\n${trimBlock(frame.out)}\n`
        } else if (name === 'blockquote') {
          const body = trimBlock(frame.out).replace(/\n{3,}/g, '\n\n')
          parent.out += `\n\n${body.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')}\n\n`
        } else {
          parent.out += `\n\n${trimBlock(frame.out)}\n\n`
        }
      },
    },
    { decodeEntities: true },
  )
  parser.write(html)
  parser.end()
  while (stack.length > 1) {
    const frame = stack.pop()!
    top().out += `\n\n${trimBlock(frame.out)}\n\n`
  }
  return stack[0].out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd()
}

export function plainText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = htmlToText(value).replace(/\s+/g, ' ').trim()
  return text === '' ? null : text
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `node --test src/content.test.ts && npm run typecheck`
Expected: PASS. If `sanitize-html` prints void elements as `<img ...>` rather than `<img ... />`, update the expected strings in the test, never the configuration. If `@types/sanitize-html`'s `transformTags` signature rejects returning `attribs` without the original keys, type the callbacks' return as `sanitize.Tag`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/content.ts src/content.test.ts
git commit -m "feat: sanitize remote html and render it as plain text

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Normalizing remote objects

**Files:**
- Create: `src/objects.ts`
- Test: `src/objects.test.ts`

**Interfaces:**
- Consumes: `sanitizeHtml`, `htmlToText`, `plainText` (`src/content.ts`); Fedify vocab classes
- Produces:
  ```ts
  export const ITEM_TYPES: readonly ['Note', 'Article', 'Page', 'Question', 'Image', 'Video', 'Audio']
  export type ItemType = (typeof ITEM_TYPES)[number]
  export type Visibility = 'public' | 'unlisted' | 'followers' | 'direct'
  export type AttachmentKind = 'image' | 'video' | 'audio' | 'other'
  export type ItemAttachment = { url: string; media_type: string | null; kind: AttachmentKind; description: string | null; width: number | null; height: number | null }
  export type ItemHashtag = { name: string; url: string | null }
  export type ItemMention = { actor_id: string; handle: string | null }
  export type ItemDraft = {
    objectId: string; type: ItemType; url: string; authorId: string; visibility: Visibility
    published: string; updated: string | null; title: string | null; summary: string | null; sensitive: boolean
    contentHtml: string; contentText: string; language: string | null; inReplyTo: string | null
    attachments: ItemAttachment[]; hashtags: ItemHashtag[]; mentions: ItemMention[]
  }
  export const LIMITS: { contentBytes: number; attachments: number; hashtags: number; mentions: number }
  export type NormalizeOptions = { followersUrl: string | null; now: Date; documentLoader?: DocumentLoader }
  export function classifyVisibility(to: readonly URL[], cc: readonly URL[], followersUrl: string | null): Visibility
  export async function normalizeObject(object: APObject, options: NormalizeOptions): Promise<ItemDraft | null>
  ```
  The attachment, hashtag and mention shapes are snake_case on purpose: they are stored as JSON and served unchanged.

- [ ] **Step 1: Write the failing tests**

`src/objects.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Article, Document, Event, Hashtag, LanguageString, Link, Mention, Note, PUBLIC_COLLECTION, Tombstone,
} from '@fedify/vocab'
import { LIMITS, classifyVisibility, normalizeObject } from './objects.ts'

const now = new Date('2026-10-16T06:12:05.412Z')
const ALICE = 'https://social.test/users/alice'
const FOLLOWERS = `${ALICE}/followers`

test('classifies visibility from addressing', () => {
  const followers = new URL(FOLLOWERS)
  const me = new URL('https://ap.test/users/inner-monologue')
  assert.equal(classifyVisibility([PUBLIC_COLLECTION], [followers], FOLLOWERS), 'public')
  assert.equal(classifyVisibility([new URL('as:Public')], [], null), 'public')
  assert.equal(classifyVisibility([followers], [PUBLIC_COLLECTION], FOLLOWERS), 'unlisted')
  assert.equal(classifyVisibility([followers], [me], FOLLOWERS), 'followers')
  assert.equal(classifyVisibility([me], [followers], FOLLOWERS), 'followers')
  assert.equal(classifyVisibility([me], [], FOLLOWERS), 'direct')
  assert.equal(classifyVisibility([followers], [], null), 'direct')
})

test('normalizes a Mastodon note', async () => {
  const html = '<p>Hello <a href="/tags/coffee" class="mention hashtag">#coffee</a></p>'
  const note = new Note({
    id: new URL(`${ALICE}/statuses/1`),
    attribution: new URL(ALICE),
    to: PUBLIC_COLLECTION,
    cc: new URL(FOLLOWERS),
    contents: [html, new LanguageString(html, 'en')],
    url: new URL('https://social.test/@alice/1'),
    published: Temporal.Instant.from('2026-10-16T06:12:03Z'),
    name: 'ignored for notes',
    summary: 'Coffee talk',
    sensitive: true,
    replyTarget: new URL(`${ALICE}/statuses/0`),
    attachments: [
      new Document({ url: new URL('https://files.social.test/a.jpg'), mediaType: 'image/jpeg', name: 'A kettle', width: 1600, height: 1200 }),
      new Document({ url: new URL('ftp://files.social.test/b.jpg') }),
    ],
    tags: [
      new Hashtag({ name: '#coffee', href: new URL('https://social.test/tags/coffee') }),
      new Mention({ name: '@carol@other.test', href: new URL('https://other.test/users/carol') }),
    ],
  })
  assert.deepEqual(await normalizeObject(note, { followersUrl: FOLLOWERS, now }), {
    objectId: `${ALICE}/statuses/1`,
    type: 'Note',
    url: 'https://social.test/@alice/1',
    authorId: ALICE,
    visibility: 'public',
    published: '2026-10-16T06:12:03.000Z',
    updated: null,
    title: null,
    summary: 'Coffee talk',
    sensitive: true,
    contentHtml: '<p>Hello <a href="https://social.test/tags/coffee" class="mention hashtag" rel="nofollow noopener noreferrer">#coffee</a></p>',
    contentText: 'Hello #coffee',
    language: 'en',
    inReplyTo: `${ALICE}/statuses/0`,
    attachments: [
      { url: 'https://files.social.test/a.jpg', media_type: 'image/jpeg', kind: 'image', description: 'A kettle', width: 1600, height: 1200 },
    ],
    hashtags: [{ name: 'coffee', url: 'https://social.test/tags/coffee' }],
    mentions: [{ actor_id: 'https://other.test/users/carol', handle: '@carol@other.test' }],
  })
})

test('normalizes an article with a title, a link list and no dates', async () => {
  const article = new Article({
    id: new URL('https://write.test/bob/autumn'),
    attribution: new URL('https://write.test/api/collections/bob'),
    to: PUBLIC_COLLECTION,
    name: 'Autumn <em>reading</em>',
    summary: 'Five books',
    content: '<h2>One</h2><p>A slow book.</p><script>x()</script>',
    urls: [
      new Link({ href: new URL('https://write.test/bob/autumn.json'), mediaType: 'application/json' }),
      new Link({ href: new URL('https://write.test/bob/autumn'), mediaType: 'text/html' }),
    ],
  })
  const draft = await normalizeObject(article, { followersUrl: null, now })
  assert.ok(draft)
  assert.equal(draft.type, 'Article')
  assert.equal(draft.title, 'Autumn reading')
  assert.equal(draft.summary, 'Five books')
  assert.equal(draft.url, 'https://write.test/bob/autumn')
  assert.equal(draft.published, now.toISOString())
  assert.equal(draft.contentHtml, '<h2>One</h2><p>A slow book.</p>')
  assert.equal(draft.contentText, 'One\n\nA slow book.')
  assert.equal(draft.language, null)
  assert.equal(draft.sensitive, false)
})

test('falls back to the id for url and to empty content', async () => {
  const note = new Note({ id: new URL(`${ALICE}/statuses/2`), attribution: new URL(ALICE), to: PUBLIC_COLLECTION })
  const draft = await normalizeObject(note, { followersUrl: FOLLOWERS, now })
  assert.equal(draft?.url, `${ALICE}/statuses/2`)
  assert.equal(draft?.contentHtml, '')
  assert.equal(draft?.contentText, '')
})

test('caps attachments and refuses oversized content', async () => {
  const many = Array.from({ length: 25 }, (_, i) => new Document({ url: new URL(`https://files.social.test/${i}.png`), mediaType: 'image/png' }))
  const note = new Note({ id: new URL(`${ALICE}/statuses/3`), attribution: new URL(ALICE), to: PUBLIC_COLLECTION, attachments: many })
  assert.equal((await normalizeObject(note, { followersUrl: null, now }))?.attachments.length, LIMITS.attachments)

  const huge = new Note({
    id: new URL(`${ALICE}/statuses/4`), attribution: new URL(ALICE), to: PUBLIC_COLLECTION,
    content: `<p>${'a'.repeat(LIMITS.contentBytes + 1)}</p>`,
  })
  assert.equal(await normalizeObject(huge, { followersUrl: null, now }), null)
})

test('refuses unsupported types and objects without id or author', async () => {
  assert.equal(await normalizeObject(new Tombstone({ id: new URL(`${ALICE}/statuses/5`) }), { followersUrl: null, now }), null)
  assert.equal(await normalizeObject(new Event({ id: new URL(`${ALICE}/events/1`), attribution: new URL(ALICE) }), { followersUrl: null, now }), null)
  assert.equal(await normalizeObject(new Note({ id: new URL(`${ALICE}/statuses/6`) }), { followersUrl: null, now }), null)
  assert.equal(await normalizeObject(new Note({ attribution: new URL(ALICE) }), { followersUrl: null, now }), null)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/objects.test.ts`
Expected: FAIL, `Cannot find module '.../src/objects.ts'`.

- [ ] **Step 3: Implement `src/objects.ts`**

```ts
import type { DocumentLoader } from '@fedify/fedify'
import {
  Article, Audio, Document, Hashtag, Image, LanguageString, Link, Mention, Note, Page, PUBLIC_COLLECTION, Question, Video,
  type Object as APObject,
} from '@fedify/vocab'
import { htmlToText, plainText, sanitizeHtml } from './content.ts'

export const ITEM_TYPES = ['Note', 'Article', 'Page', 'Question', 'Image', 'Video', 'Audio'] as const
export type ItemType = (typeof ITEM_TYPES)[number]
export type Visibility = 'public' | 'unlisted' | 'followers' | 'direct'
export type AttachmentKind = 'image' | 'video' | 'audio' | 'other'

export type ItemAttachment = {
  url: string
  media_type: string | null
  kind: AttachmentKind
  description: string | null
  width: number | null
  height: number | null
}
export type ItemHashtag = { name: string; url: string | null }
export type ItemMention = { actor_id: string; handle: string | null }

export type ItemDraft = {
  objectId: string
  type: ItemType
  url: string
  authorId: string
  visibility: Visibility
  published: string
  updated: string | null
  title: string | null
  summary: string | null
  sensitive: boolean
  contentHtml: string
  contentText: string
  language: string | null
  inReplyTo: string | null
  attachments: ItemAttachment[]
  hashtags: ItemHashtag[]
  mentions: ItemMention[]
}

export const LIMITS = { contentBytes: 256 * 1024, attachments: 20, hashtags: 50, mentions: 50 }

export type NormalizeOptions = { followersUrl: string | null; now: Date; documentLoader?: DocumentLoader }

const PUBLIC = new Set([PUBLIC_COLLECTION.href, 'as:Public', 'Public'])

export function classifyVisibility(to: readonly URL[], cc: readonly URL[], followersUrl: string | null): Visibility {
  const isPublic = (url: URL) => PUBLIC.has(url.href)
  if (to.some(isPublic)) return 'public'
  if (cc.some(isPublic)) return 'unlisted'
  if (followersUrl !== null && [...to, ...cc].some((url) => url.href === followersUrl)) return 'followers'
  return 'direct'
}

function typeOf(object: APObject): ItemType | null {
  if (object instanceof Note) return 'Note'
  if (object instanceof Article) return 'Article'
  if (object instanceof Page) return 'Page'
  if (object instanceof Question) return 'Question'
  if (object instanceof Image) return 'Image'
  if (object instanceof Video) return 'Video'
  if (object instanceof Audio) return 'Audio'
  return null
}

function isWeb(url: URL | null | undefined): url is URL {
  return url instanceof URL && (url.protocol === 'https:' || url.protocol === 'http:')
}

function hrefOf(value: URL | Link | null | undefined): URL | null {
  if (value instanceof URL) return value
  if (value instanceof Link) return value.href
  return null
}

function pageUrl(object: APObject): string {
  const html = object.urls.find((u) => u instanceof Link && u.mediaType === 'text/html' && isWeb(u.href))
  const any = html ?? object.urls.find((u) => isWeb(hrefOf(u)))
  return hrefOf(any)?.href ?? object.id!.href
}

function iso(instant: Temporal.Instant | null): string | null {
  return instant === null ? null : new Date(instant.epochMilliseconds).toISOString()
}

function kindOf(mediaType: string | null, fallback: AttachmentKind): AttachmentKind {
  const prefix = mediaType?.split('/')[0]
  return prefix === 'image' || prefix === 'video' || prefix === 'audio' ? prefix : fallback
}

function size(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

function attachmentFor(value: unknown): ItemAttachment | null {
  if (value instanceof Link) {
    if (!isWeb(value.href)) return null
    const mediaType = value.mediaType ?? null
    return {
      url: value.href.href, media_type: mediaType, kind: kindOf(mediaType, 'other'),
      description: plainText(value.name?.toString()), width: size(value.width), height: size(value.height),
    }
  }
  if (value instanceof Document || value instanceof Image || value instanceof Video || value instanceof Audio) {
    const url = value.urls.map(hrefOf).find(isWeb)
    if (!url) return null
    const mediaType = value.mediaType ?? null
    const fallback: AttachmentKind =
      value instanceof Image ? 'image' : value instanceof Video ? 'video' : value instanceof Audio ? 'audio' : 'other'
    return {
      url: url.href, media_type: mediaType, kind: kindOf(mediaType, fallback),
      description: plainText(value.name?.toString()), width: size(value.width), height: size(value.height),
    }
  }
  return null
}

function languageOf(object: APObject): string | null {
  const tagged = object.contents.find((c) => c instanceof LanguageString)
  return tagged instanceof LanguageString ? tagged.locale.baseName : null
}

export async function normalizeObject(object: APObject, { followersUrl, now, documentLoader }: NormalizeOptions): Promise<ItemDraft | null> {
  const type = typeOf(object)
  if (type === null || object.id === null || object.attributionId === null) return null

  const contentHtml = object.content === null ? '' : sanitizeHtml(object.content.toString(), object.id)
  if (Buffer.byteLength(contentHtml) > LIMITS.contentBytes) return null

  const options = { documentLoader, suppressError: true }
  const attachments: ItemAttachment[] = []
  for await (const value of object.getAttachments(options)) {
    if (attachments.length === LIMITS.attachments) break
    const attachment = attachmentFor(value)
    if (attachment) attachments.push(attachment)
  }

  const hashtags: ItemHashtag[] = []
  const mentions: ItemMention[] = []
  for await (const tag of object.getTags(options)) {
    if (tag instanceof Hashtag) {
      const name = tag.name?.toString().replace(/^#/, '').trim()
      if (name && hashtags.length < LIMITS.hashtags) hashtags.push({ name, url: isWeb(tag.href) ? tag.href.href : null })
    } else if (tag instanceof Mention) {
      const text = tag.name?.toString().trim()
      if (tag.href && mentions.length < LIMITS.mentions) {
        mentions.push({ actor_id: tag.href.href, handle: text ? (text.startsWith('@') ? text : `@${text}`) : null })
      }
    }
  }

  return {
    objectId: object.id.href,
    type,
    url: pageUrl(object),
    authorId: object.attributionId.href,
    visibility: classifyVisibility(object.toIds, object.ccIds, followersUrl),
    published: iso(object.published) ?? now.toISOString(),
    updated: iso(object.updated),
    title: type === 'Note' ? null : plainText(object.name?.toString()),
    summary: plainText(object.summary?.toString()),
    sensitive: object.sensitive ?? false,
    contentHtml,
    contentText: htmlToText(contentHtml),
    language: languageOf(object),
    inReplyTo: object.replyTargetId?.href ?? null,
    attachments,
    hashtags,
    mentions,
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `node --test src/objects.test.ts && npm run typecheck`
Expected: PASS. Fedify notes: `LanguageString` may be exported from a runtime package rather than `@fedify/vocab` (look at what `Note`'s `contents` type imports in its `.d.ts` and import from there); in some versions its tag is `.language` (a `LanguageTag`, use `.language.compact()`) rather than `.locale` (an `Intl.Locale`, use `.locale.baseName`). If `Image`, `Video` or `Audio` already extend `Document`, the extra `instanceof` checks are harmless. If the `Event` class is named differently, use any non-supported vocab type in that test.

- [ ] **Step 5: Commit**

```bash
git add src/objects.ts src/objects.test.ts
git commit -m "feat: normalize remote objects into item drafts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Store actors, follows and items

**Files:**
- Modify: `src/store.ts`
- Create: `test/items.ts`
- Test: `src/store.test.ts` (append)

**Interfaces:**
- Consumes: `ItemDraft` (`src/objects.ts`)
- Produces (added to `src/store.ts`):
  ```ts
  export type FollowState = 'pending' | 'accepted' | 'rejected'
  export type ActorRow = {
    id: string; handle: string | null; name: string | null; avatarUrl: string | null; profileUrl: string | null
    inbox: string | null; sharedInbox: string | null; followersUrl: string | null; fetchedAt: string
  }
  export type FollowingRow = { siteId: string; actorId: string; state: FollowState; followId: string; createdAt: string; stateChangedAt: string }
  export type BoostInfo = { actorId: string; activityId: string; boostedAt: string }
  export type ItemRow = ItemDraft & { seq: number; siteId: string; boost: BoostInfo | null; receivedAt: string; deletedAt: string | null }
  export type ItemQuery = { order: 'asc' | 'desc'; afterSeq: number | null; since: string | null; until: string | null; limit: number }
  export type ReceiveResult = 'inserted' | 'upgraded' | 'ignored'
  // on Store:
  upsertActor(actor: ActorRow): void
  getActor(id: string): ActorRow | undefined
  deleteActor(id: string): void
  saveFollowing(row: FollowingRow): void
  getFollowing(siteId: string, actorId: string): FollowingRow | undefined
  findFollowingByFollowId(followId: string): FollowingRow | undefined
  listFollowing(siteId: string, state?: FollowState): FollowingRow[]
  countFollowing(siteId: string): number
  setFollowingState(siteId: string, actorId: string, state: FollowState, now: Date): void
  removeFollowing(siteId: string, actorId: string): void
  removeFollowingOfActor(actorId: string): number
  sitesFollowing(actorId: string): string[]
  receiveDirect(siteId: string, draft: ItemDraft, now: Date): ReceiveResult
  receiveBoost(siteId: string, draft: ItemDraft, boost: BoostInfo, now: Date): ReceiveResult
  getItem(siteId: string, objectId: string): ItemRow | undefined
  siteIdsWithObject(objectId: string, authorId: string): string[]
  updateObject(objectId: string, authorId: string, draft: ItemDraft): number
  tombstoneObject(objectId: string, authorId: string, now: Date): number
  tombstoneAuthor(authorId: string, now: Date): number
  removeBoost(activityId: string, actorId: string): number
  listItems(siteId: string, query: ItemQuery): ItemRow[]
  prune(siteId: string, before: string): number
  pruneActors(before: string): number
  ```
  `test/items.ts` produces `SITE`, `ALICE`, `BOB`, `CAROL`, `DAVE`, `at(minute)`, `draft(n, overrides?)`, `actor(id, name, overrides?)`, `boost(actorId, activityId?, minute?)`, `following(actorId, state, minute?, followId?)`.

- [ ] **Step 1: Write the test helper `test/items.ts`**

```ts
import type { ActorRow, BoostInfo, FollowState, FollowingRow } from '../src/store.ts'
import type { ItemDraft } from '../src/objects.ts'

export const SITE = 'inner-monologue'
export const ALICE = 'https://social.test/users/alice'
export const BOB = 'https://social.test/users/bob'
export const CAROL = 'https://other.test/users/carol'
export const DAVE = 'https://other.test/users/dave'

export function at(minute: number): Date {
  return new Date(Date.UTC(2026, 9, 16, 6, minute))
}

export function draft(n: number, overrides: Partial<ItemDraft> = {}): ItemDraft {
  return {
    objectId: `${ALICE}/statuses/${n}`,
    type: 'Note',
    url: `https://social.test/@alice/${n}`,
    authorId: ALICE,
    visibility: 'public',
    published: '2026-10-16T06:00:00.000Z',
    updated: null,
    title: null,
    summary: null,
    sensitive: false,
    contentHtml: `<p>Post ${n}</p>`,
    contentText: `Post ${n}`,
    language: 'en',
    inReplyTo: null,
    attachments: [],
    hashtags: [],
    mentions: [],
    ...overrides,
  }
}

export function actor(id: string, name: string, overrides: Partial<ActorRow> = {}): ActorRow {
  const url = new URL(id)
  const user = url.pathname.split('/').at(-1)!
  return {
    id,
    handle: `@${user}@${url.host}`,
    name,
    avatarUrl: `${url.origin}/avatars/${user}.png`,
    profileUrl: `${url.origin}/@${user}`,
    inbox: `${id}/inbox`,
    sharedInbox: null,
    followersUrl: `${id}/followers`,
    fetchedAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  }
}

export function boost(actorId: string, activityId = `${actorId}/statuses/99/activity`, minute = 0): BoostInfo {
  return { actorId, activityId, boostedAt: at(minute).toISOString() }
}

export function following(
  actorId: string,
  state: FollowState,
  minute = 0,
  followId = `https://ap.test/users/inner-monologue#follows/${actorId.split('/').at(-1)}-${minute}`,
): FollowingRow {
  return { siteId: SITE, actorId, state, followId, createdAt: at(minute).toISOString(), stateChangedAt: at(minute).toISOString() }
}
```

- [ ] **Step 2: Write the failing tests**

Append to `src/store.test.ts`; add `type ItemQuery, type ItemRow` to its existing import from `./store.ts` and move the new `../test/items.ts` import up next to the others:
```ts
import { ALICE, BOB, CAROL, DAVE, SITE, actor, at, boost, draft, following } from '../test/items.ts'

function fresh() {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  return store
}

const all = (store: Store, overrides: Partial<ItemQuery> = {}, siteId = SITE) =>
  store.listItems(siteId, { order: 'asc', afterSeq: null, since: null, until: null, limit: 100, ...overrides })
const names = (rows: ItemRow[]) => rows.map((r) => r.objectId.split('/').at(-1))

test('upserts, reads and deletes actors', () => {
  const store = fresh()
  store.upsertActor(actor(ALICE, 'Alice'))
  store.upsertActor(actor(ALICE, 'Alice B.'))
  assert.equal(store.getActor(ALICE)?.name, 'Alice B.')
  assert.equal(store.getActor(ALICE)?.handle, '@alice@social.test')
  store.deleteActor(ALICE)
  assert.equal(store.getActor(ALICE), undefined)
})

test('keeps following rows and their state', () => {
  const store = fresh()
  store.saveFollowing(following(ALICE, 'pending', 0, 'f1'))
  assert.equal(store.findFollowingByFollowId('f1')?.actorId, ALICE)
  assert.deepEqual(store.sitesFollowing(ALICE), [])
  store.setFollowingState(SITE, ALICE, 'accepted', at(1))
  assert.deepEqual(store.sitesFollowing(ALICE), [SITE])
  assert.equal(store.getFollowing(SITE, ALICE)?.stateChangedAt, at(1).toISOString())

  store.saveFollowing(following(ALICE, 'pending', 5, 'f2'))
  const row = store.getFollowing(SITE, ALICE)!
  assert.equal(row.createdAt, at(0).toISOString())
  assert.equal(row.followId, 'f2')
  assert.equal(row.state, 'pending')
  assert.equal(store.findFollowingByFollowId('f1'), undefined)

  store.saveFollowing(following(BOB, 'accepted', 2, 'f3'))
  assert.deepEqual(store.listFollowing(SITE).map((f) => f.actorId), [ALICE, BOB])
  assert.deepEqual(store.listFollowing(SITE, 'accepted').map((f) => f.actorId), [BOB])
  assert.equal(store.countFollowing(SITE), 2)
  store.removeFollowing(SITE, ALICE)
  assert.equal(store.removeFollowingOfActor(BOB), 1)
  assert.equal(store.countFollowing(SITE), 0)
})

test('stores an object once per site', () => {
  const store = fresh()
  assert.equal(store.receiveDirect(SITE, draft(1), at(0)), 'inserted')
  assert.equal(store.receiveDirect(SITE, draft(1, { contentText: 'changed' }), at(1)), 'ignored')
  assert.equal(store.receiveBoost(SITE, draft(1), boost(CAROL), at(2)), 'ignored')
  assert.equal(store.receiveDirect('other', draft(1), at(3)), 'inserted')
  assert.deepEqual(names(all(store)), ['1'])
  assert.equal(all(store)[0].contentText, 'Post 1')
  assert.equal(all(store)[0].receivedAt, at(0).toISOString())
})

test('a Create after a boost turns it into a direct item in place', () => {
  const store = fresh()
  store.receiveBoost(SITE, draft(1), boost(CAROL), at(0))
  store.receiveDirect(SITE, draft(2), at(1))
  const before = store.getItem(SITE, draft(1).objectId)!
  assert.deepEqual(before.boost, boost(CAROL))
  assert.equal(store.receiveDirect(SITE, draft(1, { contentText: 'fresh' }), at(5)), 'upgraded')
  const after = store.getItem(SITE, draft(1).objectId)!
  assert.equal(after.boost, null)
  assert.equal(after.contentText, 'fresh')
  assert.equal(after.seq, before.seq)
  assert.equal(after.receivedAt, before.receivedAt)
  assert.deepEqual(names(all(store)), ['1', '2'])
})

test('updates and tombstones only by the author, and tombstones stay', () => {
  const store = fresh()
  store.receiveDirect(SITE, draft(1), at(0))
  store.receiveDirect('other', draft(1), at(0))
  assert.equal(store.updateObject(draft(1).objectId, BOB, draft(1, { contentText: 'hijack' })), 0)
  assert.equal(store.updateObject(draft(1).objectId, ALICE, draft(1, { contentText: 'edited', updated: at(3).toISOString() })), 2)
  assert.equal(store.getItem(SITE, draft(1).objectId)?.contentText, 'edited')
  assert.deepEqual(store.siteIdsWithObject(draft(1).objectId, ALICE), [SITE, 'other'])

  assert.equal(store.tombstoneObject(draft(1).objectId, BOB, at(4)), 0)
  assert.equal(store.tombstoneObject(draft(1).objectId, ALICE, at(4)), 2)
  const gone = store.getItem(SITE, draft(1).objectId)!
  assert.equal(gone.deletedAt, at(4).toISOString())
  assert.equal(gone.contentHtml, '')
  assert.equal(gone.contentText, '')
  assert.equal(store.receiveDirect(SITE, draft(1), at(5)), 'ignored')
  assert.equal(store.receiveBoost(SITE, draft(1), boost(CAROL), at(5)), 'ignored')
  assert.equal(all(store).length, 0)
  assert.deepEqual(store.siteIdsWithObject(draft(1).objectId, ALICE), [])
})

test('tombstones everything by an author and removes boosts by activity', () => {
  const store = fresh()
  store.receiveDirect(SITE, draft(1), at(0))
  store.receiveDirect(SITE, draft(2, { objectId: `${BOB}/statuses/2`, authorId: BOB }), at(1))
  store.receiveBoost(SITE, draft(3), boost(CAROL, 'https://other.test/announces/3'), at(2))
  assert.equal(store.removeBoost('https://other.test/announces/3', BOB), 0)
  assert.equal(store.removeBoost('https://other.test/announces/3', CAROL), 1)
  assert.equal(store.getItem(SITE, draft(3).objectId), undefined)
  assert.equal(store.tombstoneAuthor(ALICE, at(3)), 1)
  assert.deepEqual(all(store).map((r) => r.authorId), [BOB])
})

test('lists in arrival order with keyset paging, stable under inserts', () => {
  const store = fresh()
  for (let i = 1; i <= 4; i++) store.receiveDirect(SITE, draft(i), at(i))
  const firstDesc = all(store, { order: 'desc', limit: 2 })
  assert.deepEqual(names(firstDesc), ['4', '3'])
  store.receiveDirect(SITE, draft(5), at(5))
  assert.deepEqual(names(all(store, { order: 'desc', limit: 2, afterSeq: firstDesc[1].seq })), ['2', '1'])

  const firstAsc = all(store, { limit: 2 })
  assert.deepEqual(names(firstAsc), ['1', '2'])
  store.receiveDirect(SITE, draft(6), at(6))
  assert.deepEqual(names(all(store, { afterSeq: firstAsc[1].seq })), ['3', '4', '5', '6'])
})

test('filters by received_at, since exclusive and until inclusive', () => {
  const store = fresh()
  store.receiveDirect(SITE, draft(1), at(0))
  store.receiveDirect(SITE, draft(2), at(10))
  store.receiveDirect(SITE, draft(3), at(20))
  assert.deepEqual(names(all(store, { since: at(0).toISOString(), until: at(10).toISOString() })), ['2'])
  assert.deepEqual(names(all(store, { since: at(10).toISOString() })), ['3'])
  assert.deepEqual(names(all(store, { until: at(0).toISOString() })), ['1'])
})

test('prunes items by received_at and actors nobody uses', () => {
  const store = fresh()
  store.receiveDirect(SITE, draft(1), at(0))
  store.receiveDirect(SITE, draft(2), at(30))
  assert.equal(store.prune(SITE, at(10).toISOString()), 1)
  assert.deepEqual(names(all(store)), ['2'])

  store.upsertActor(actor(ALICE, 'Alice'))
  store.upsertActor(actor(BOB, 'Bob'))
  store.saveFollowing(following(BOB, 'accepted'))
  store.upsertActor(actor(CAROL, 'Carol'))
  store.upsertActor(actor(DAVE, 'Dave', { fetchedAt: at(20).toISOString() }))
  assert.equal(store.pruneActors(at(10).toISOString()), 1)
  assert.equal(store.getActor(CAROL), undefined)
  assert.ok(store.getActor(ALICE) && store.getActor(BOB) && store.getActor(DAVE))
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test src/store.test.ts`
Expected: FAIL, `store.upsertActor is not a function` (v1 tests still pass).

- [ ] **Step 4: Implement**

In `src/store.ts`, add the import and types:
```ts
import type { ItemDraft } from './objects.ts'

export type FollowState = 'pending' | 'accepted' | 'rejected'

export type ActorRow = {
  id: string
  handle: string | null
  name: string | null
  avatarUrl: string | null
  profileUrl: string | null
  inbox: string | null
  sharedInbox: string | null
  followersUrl: string | null
  fetchedAt: string
}

export type FollowingRow = {
  siteId: string
  actorId: string
  state: FollowState
  followId: string
  createdAt: string
  stateChangedAt: string
}

export type BoostInfo = { actorId: string; activityId: string; boostedAt: string }

export type ItemRow = ItemDraft & {
  seq: number
  siteId: string
  boost: BoostInfo | null
  receivedAt: string
  deletedAt: string | null
}

export type ItemQuery = { order: 'asc' | 'desc'; afterSeq: number | null; since: string | null; until: string | null; limit: number }

export type ReceiveResult = 'inserted' | 'upgraded' | 'ignored'
```

Append to the `SCHEMA` string (before its closing backtick):
```sql
CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  handle TEXT,
  name TEXT,
  avatar_url TEXT,
  profile_url TEXT,
  inbox TEXT,
  shared_inbox TEXT,
  followers_url TEXT,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS following (
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'rejected')),
  follow_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  state_changed_at TEXT NOT NULL,
  PRIMARY KEY (site_id, actor_id)
);
CREATE TABLE IF NOT EXISTS items (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  author_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  published TEXT NOT NULL,
  updated TEXT,
  title TEXT,
  summary TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  content_html TEXT NOT NULL,
  content_text TEXT NOT NULL,
  language TEXT,
  in_reply_to TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  hashtags TEXT NOT NULL DEFAULT '[]',
  mentions TEXT NOT NULL DEFAULT '[]',
  boost_actor_id TEXT,
  boost_activity_id TEXT,
  boosted_at TEXT,
  received_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (site_id, object_id)
);
CREATE INDEX IF NOT EXISTS items_site_seq ON items (site_id, seq);
CREATE INDEX IF NOT EXISTS items_site_received ON items (site_id, received_at);
CREATE INDEX IF NOT EXISTS items_author ON items (author_id);
CREATE INDEX IF NOT EXISTS items_boost_activity ON items (boost_activity_id) WHERE boost_activity_id IS NOT NULL;
```

Add helpers next to `toPost`:
```ts
function toActor(row: Row): ActorRow {
  return {
    id: row.id as string,
    handle: (row.handle as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    profileUrl: (row.profile_url as string | null) ?? null,
    inbox: (row.inbox as string | null) ?? null,
    sharedInbox: (row.shared_inbox as string | null) ?? null,
    followersUrl: (row.followers_url as string | null) ?? null,
    fetchedAt: row.fetched_at as string,
  }
}

function toFollowing(row: Row): FollowingRow {
  return {
    siteId: row.site_id as string,
    actorId: row.actor_id as string,
    state: row.state as FollowState,
    followId: row.follow_id as string,
    createdAt: row.created_at as string,
    stateChangedAt: row.state_changed_at as string,
  }
}

function toItem(row: Row): ItemRow {
  return {
    seq: Number(row.seq),
    siteId: row.site_id as string,
    objectId: row.object_id as string,
    type: row.type as ItemRow['type'],
    url: row.url as string,
    authorId: row.author_id as string,
    visibility: row.visibility as ItemRow['visibility'],
    published: row.published as string,
    updated: (row.updated as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    sensitive: Number(row.sensitive) === 1,
    contentHtml: row.content_html as string,
    contentText: row.content_text as string,
    language: (row.language as string | null) ?? null,
    inReplyTo: (row.in_reply_to as string | null) ?? null,
    attachments: JSON.parse(row.attachments as string),
    hashtags: JSON.parse(row.hashtags as string),
    mentions: JSON.parse(row.mentions as string),
    boost: row.boost_actor_id
      ? { actorId: row.boost_actor_id as string, activityId: row.boost_activity_id as string, boostedAt: row.boosted_at as string }
      : null,
    receivedAt: row.received_at as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
  }
}

const CONTENT_SET = `type = ?, url = ?, visibility = ?, published = ?, updated = ?, title = ?, summary = ?, sensitive = ?,
  content_html = ?, content_text = ?, language = ?, in_reply_to = ?, attachments = ?, hashtags = ?, mentions = ?`

function contentParams(d: ItemDraft) {
  return [
    d.type, d.url, d.visibility, d.published, d.updated, d.title, d.summary, d.sensitive ? 1 : 0,
    d.contentHtml, d.contentText, d.language, d.inReplyTo,
    JSON.stringify(d.attachments), JSON.stringify(d.hashtags), JSON.stringify(d.mentions),
  ]
}

const TOMBSTONE_SET = `deleted_at = ?, content_html = '', content_text = '', title = NULL, summary = NULL,
  attachments = '[]', hashtags = '[]', mentions = '[]'`
```

Add these methods to `Store`:
```ts
  upsertActor(a: ActorRow): void {
    this.db
      .prepare(
        `INSERT INTO actors (id, handle, name, avatar_url, profile_url, inbox, shared_inbox, followers_url, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET handle = excluded.handle, name = excluded.name, avatar_url = excluded.avatar_url,
           profile_url = excluded.profile_url, inbox = excluded.inbox, shared_inbox = excluded.shared_inbox,
           followers_url = excluded.followers_url, fetched_at = excluded.fetched_at`,
      )
      .run(a.id, a.handle, a.name, a.avatarUrl, a.profileUrl, a.inbox, a.sharedInbox, a.followersUrl, a.fetchedAt)
  }

  getActor(id: string): ActorRow | undefined {
    const row = this.db.prepare('SELECT * FROM actors WHERE id = ?').get(id)
    return row ? toActor(row) : undefined
  }

  deleteActor(id: string): void {
    this.db.prepare('DELETE FROM actors WHERE id = ?').run(id)
  }

  saveFollowing(f: FollowingRow): void {
    this.db
      .prepare(
        `INSERT INTO following (site_id, actor_id, state, follow_id, created_at, state_changed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (site_id, actor_id) DO UPDATE SET state = excluded.state, follow_id = excluded.follow_id,
           state_changed_at = excluded.state_changed_at`,
      )
      .run(f.siteId, f.actorId, f.state, f.followId, f.createdAt, f.stateChangedAt)
  }

  getFollowing(siteId: string, actorId: string): FollowingRow | undefined {
    const row = this.db.prepare('SELECT * FROM following WHERE site_id = ? AND actor_id = ?').get(siteId, actorId)
    return row ? toFollowing(row) : undefined
  }

  findFollowingByFollowId(followId: string): FollowingRow | undefined {
    const row = this.db.prepare('SELECT * FROM following WHERE follow_id = ?').get(followId)
    return row ? toFollowing(row) : undefined
  }

  listFollowing(siteId: string, state?: FollowState): FollowingRow[] {
    return this.db
      .prepare('SELECT * FROM following WHERE site_id = ? AND (? IS NULL OR state = ?) ORDER BY created_at, actor_id')
      .all(siteId, state ?? null, state ?? null)
      .map(toFollowing)
  }

  countFollowing(siteId: string): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM following WHERE site_id = ?').get(siteId)!.n)
  }

  setFollowingState(siteId: string, actorId: string, state: FollowState, now: Date): void {
    this.db
      .prepare('UPDATE following SET state = ?, state_changed_at = ? WHERE site_id = ? AND actor_id = ?')
      .run(state, now.toISOString(), siteId, actorId)
  }

  removeFollowing(siteId: string, actorId: string): void {
    this.db.prepare('DELETE FROM following WHERE site_id = ? AND actor_id = ?').run(siteId, actorId)
  }

  removeFollowingOfActor(actorId: string): number {
    return Number(this.db.prepare('DELETE FROM following WHERE actor_id = ?').run(actorId).changes)
  }

  sitesFollowing(actorId: string): string[] {
    return this.db
      .prepare(`SELECT site_id FROM following WHERE actor_id = ? AND state = 'accepted' ORDER BY site_id`)
      .all(actorId)
      .map((row) => row.site_id as string)
  }

  insertItem(siteId: string, d: ItemDraft, boost: BoostInfo | null, now: Date): void {
    this.db
      .prepare(
        `INSERT INTO items (site_id, object_id, type, url, author_id, visibility, published, updated, title, summary, sensitive,
           content_html, content_text, language, in_reply_to, attachments, hashtags, mentions,
           boost_actor_id, boost_activity_id, boosted_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        siteId, d.objectId, d.type, d.url, d.authorId, d.visibility, d.published, d.updated, d.title, d.summary,
        d.sensitive ? 1 : 0, d.contentHtml, d.contentText, d.language, d.inReplyTo,
        JSON.stringify(d.attachments), JSON.stringify(d.hashtags), JSON.stringify(d.mentions),
        boost?.actorId ?? null, boost?.activityId ?? null, boost?.boostedAt ?? null, now.toISOString(),
      )
  }

  receiveDirect(siteId: string, d: ItemDraft, now: Date): ReceiveResult {
    const existing = this.getItem(siteId, d.objectId)
    if (!existing) {
      this.insertItem(siteId, d, null, now)
      return 'inserted'
    }
    if (existing.deletedAt !== null || existing.boost === null) return 'ignored'
    this.db
      .prepare(
        `UPDATE items SET ${CONTENT_SET}, boost_actor_id = NULL, boost_activity_id = NULL, boosted_at = NULL
         WHERE site_id = ? AND object_id = ?`,
      )
      .run(...contentParams(d), siteId, d.objectId)
    return 'upgraded'
  }

  receiveBoost(siteId: string, d: ItemDraft, boost: BoostInfo, now: Date): ReceiveResult {
    if (this.getItem(siteId, d.objectId)) return 'ignored'
    this.insertItem(siteId, d, boost, now)
    return 'inserted'
  }

  getItem(siteId: string, objectId: string): ItemRow | undefined {
    const row = this.db.prepare('SELECT * FROM items WHERE site_id = ? AND object_id = ?').get(siteId, objectId)
    return row ? toItem(row) : undefined
  }

  siteIdsWithObject(objectId: string, authorId: string): string[] {
    return this.db
      .prepare('SELECT site_id FROM items WHERE object_id = ? AND author_id = ? AND deleted_at IS NULL ORDER BY site_id')
      .all(objectId, authorId)
      .map((row) => row.site_id as string)
  }

  updateObject(objectId: string, authorId: string, d: ItemDraft): number {
    return Number(
      this.db
        .prepare(`UPDATE items SET ${CONTENT_SET} WHERE object_id = ? AND author_id = ? AND deleted_at IS NULL`)
        .run(...contentParams(d), objectId, authorId).changes,
    )
  }

  tombstoneObject(objectId: string, authorId: string, now: Date): number {
    return Number(
      this.db
        .prepare(`UPDATE items SET ${TOMBSTONE_SET} WHERE object_id = ? AND author_id = ? AND deleted_at IS NULL`)
        .run(now.toISOString(), objectId, authorId).changes,
    )
  }

  tombstoneAuthor(authorId: string, now: Date): number {
    return Number(
      this.db
        .prepare(`UPDATE items SET ${TOMBSTONE_SET} WHERE author_id = ? AND deleted_at IS NULL`)
        .run(now.toISOString(), authorId).changes,
    )
  }

  removeBoost(activityId: string, actorId: string): number {
    return Number(
      this.db.prepare('DELETE FROM items WHERE boost_activity_id = ? AND boost_actor_id = ?').run(activityId, actorId).changes,
    )
  }

  listItems(siteId: string, q: ItemQuery): ItemRow[] {
    const cmp = q.order === 'desc' ? '<' : '>'
    const dir = q.order === 'desc' ? 'DESC' : 'ASC'
    return this.db
      .prepare(
        `SELECT * FROM items WHERE site_id = ? AND deleted_at IS NULL
           AND (? IS NULL OR seq ${cmp} ?)
           AND (? IS NULL OR received_at > ?)
           AND (? IS NULL OR received_at <= ?)
         ORDER BY seq ${dir} LIMIT ?`,
      )
      .all(siteId, q.afterSeq, q.afterSeq, q.since, q.since, q.until, q.until, q.limit)
      .map(toItem)
  }

  prune(siteId: string, before: string): number {
    return Number(this.db.prepare('DELETE FROM items WHERE site_id = ? AND received_at < ?').run(siteId, before).changes)
  }

  pruneActors(before: string): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM actors WHERE fetched_at < ?
             AND id NOT IN (SELECT author_id FROM items)
             AND id NOT IN (SELECT boost_actor_id FROM items WHERE boost_actor_id IS NOT NULL)
             AND id NOT IN (SELECT actor_id FROM following)`,
        )
        .run(before).changes,
    )
  }
```

- [ ] **Step 5: Run tests and typecheck**

Run: `node --test src/store.test.ts && npm run typecheck`
Expected: PASS, v1 store tests included. `node:sqlite` binds `null` for `IS NULL` checks; if `tsc` rejects the spread in `.run(...contentParams(d), ...)`, type `contentParams` as returning `SQLInputValue[]` (from `node:sqlite`).

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/store.test.ts test/items.ts
git commit -m "feat: store actors, follows and received items

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Following other accounts

**Files:**
- Create: `src/actors.ts`, `src/following.ts`, `src/receive.ts`
- Modify: `src/federation.ts`, `test/fake-remote.ts`
- Test: `src/following.test.ts`

**Interfaces:**
- Consumes: `Store`, `ActorRow`, `FollowingRow`, `FollowState` (store); `plainText` (content); `Config`; Fedify
- Produces:
  ```ts
  // src/actors.ts
  export const ACTOR_TTL_MS: number
  export const LOOKUP_TIMEOUT_MS: number
  export class RemoteError extends Error {}
  export function withTimeout<T>(work: Promise<T>, ms?: number, what?: string): Promise<T>
  export function actorRow(actor: Actor, now: Date, options?: { documentLoader?: DocumentLoader }): Promise<ActorRow>
  export function ensureActor(ctx: Context<void>, store: Store, siteId: string, actorId: URL, now: Date, known?: Actor): Promise<ActorRow | null>
  // src/following.ts
  export const MAX_FOLLOWING: number
  export type Account = { kind: 'handle'; handle: string } | { kind: 'url'; url: URL }
  export type FollowErrorCode = 'account_not_found' | 'not_an_actor' | 'cannot_follow_self' | 'following_limit'
  export class FollowError extends Error { code: FollowErrorCode }
  export type FollowResult = { sent: boolean; following: FollowingRow }
  export type Resolver = (siteId: string, account: Account) => Promise<APObject | null>
  export type FollowsDeps = {
    config: Config; store: Store; federation: Federation<void>
    resolve?: Resolver; timeoutMs?: number; maxFollowing?: number; clock?: () => Date
  }
  export function parseAccount(input: string): Account | null
  export function accountLabel(account: Account): string
  export class Follows {
    constructor(deps: FollowsDeps)
    follow(siteId: string, account: Account): Promise<FollowResult>
    unfollow(siteId: string, account: Account): Promise<boolean>
  }
  // src/receive.ts
  export type ReceiveDeps = { config: Config; store: Store; clock?: () => Date }
  export function receiveFollowAnswer(deps: ReceiveDeps, ctx: InboxContext<void>, activity: Accept | Reject, state: 'accepted' | 'rejected'): void
  // src/federation.ts
  export type FederationDeps = { ...v1, clock?: () => Date }
  ```
  `test/fake-remote.ts` grows `AS`, `PUBLIC`, `TWO_SITE_CONFIG`, and on `FakeRemote`: `alice` and `bob` (`RemoteActor`: `actorId`, `inbox`, `followers`, `document()`), and `objects: Map<string, Record<string, unknown>>` served by path.

- [ ] **Step 1: Extend `test/fake-remote.ts`**

Replace the file with:
```ts
import { createServer, type IncomingMessage } from 'node:http'
import type { Config } from '../src/config.ts'

export const AS = 'https://www.w3.org/ns/activitystreams'
export const PUBLIC = `${AS}#Public`
export const READER_TOKEN = 'reader-token-for-tests-0123456789'

export type Delivery = { path: string; type: string; body: Record<string, unknown> }

export type RemoteActor = { actorId: string; inbox: string; followers: string; document(): Record<string, unknown> }

export type FakeRemote = {
  origin: string
  actorId: string
  inbox: string
  sharedInbox: string
  alice: RemoteActor
  bob: RemoteActor
  objects: Map<string, Record<string, unknown>>
  deliveries: Delivery[]
  close(): Promise<void>
}

export const TEST_CONFIG: Config = {
  publicUrl: new URL('https://ap.test'),
  sites: [
    {
      id: 'inner-monologue',
      handle: 'nico',
      domain: 'innermonologue.test',
      feedUrl: new URL('https://innermonologue.test/feed.xml'),
      name: 'The Open Inner Monologue',
      summary: 'Test summary',
      icon: undefined,
      syncToken: 'secret',
      deleteMissing: true,
      readerToken: READER_TOKEN,
      retentionDays: 30,
    },
  ],
}

export const TWO_SITE_CONFIG: Config = {
  ...TEST_CONFIG,
  sites: [...TEST_CONFIG.sites, { ...TEST_CONFIG.sites[0], id: 'quiet', handle: 'quiet', readerToken: undefined, retentionDays: 1 }],
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

function remoteActor(origin: string, user: string, name: string): RemoteActor {
  const actorId = `${origin}/users/${user}`
  return {
    actorId,
    inbox: `${actorId}/inbox`,
    followers: `${actorId}/followers`,
    document: () => ({
      '@context': AS,
      id: actorId,
      type: 'Person',
      preferredUsername: user,
      name,
      url: `${origin}/@${user}`,
      icon: { type: 'Image', url: `${origin}/avatars/${user}.png` },
      inbox: `${actorId}/inbox`,
      followers: `${actorId}/followers`,
      endpoints: { sharedInbox: `${origin}/inbox` },
    }),
  }
}

export async function startFakeRemote(): Promise<FakeRemote> {
  const deliveries: Delivery[] = []
  const objects = new Map<string, Record<string, unknown>>()
  let origin = ''
  let actors: Record<string, RemoteActor> = {}

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin)
    const send = (status: number, body: unknown, type = 'application/activity+json') => {
      res.writeHead(status, { 'content-type': type })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET') {
      const user = /^\/users\/([a-z]+)$/.exec(url.pathname)?.[1]
      if (user && actors[user]) return send(200, actors[user].document())
      if (url.pathname === '/.well-known/webfinger') {
        const match = /^acct:([a-z]+)@(.+)$/.exec(url.searchParams.get('resource') ?? '')
        if (match && actors[match[1]] && match[2] === url.host) {
          return send(
            200,
            { subject: `acct:${match[1]}@${url.host}`, links: [{ rel: 'self', type: 'application/activity+json', href: actors[match[1]].actorId }] },
            'application/jrd+json',
          )
        }
        return send(404, {})
      }
      const object = objects.get(url.pathname)
      if (object) return send(200, object)
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      deliveries.push({ path: url.pathname, type: String(body.type), body })
      res.writeHead(202)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  origin = `http://127.0.0.1:${address.port}`
  actors = { alice: remoteActor(origin, 'alice', 'Alice'), bob: remoteActor(origin, 'bob', 'Bob <b>Builder</b>') }
  return {
    origin,
    actorId: actors.alice.actorId,
    inbox: actors.alice.inbox,
    sharedInbox: `${origin}/inbox`,
    alice: actors.alice,
    bob: actors.bob,
    objects,
    deliveries,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
```

Run: `npm test`
Expected: v1 tests still PASS (alice keeps the same id, inbox and shared inbox).

- [ ] **Step 2: Write the failing tests**

`src/following.test.ts`:
```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryKvStore } from '@fedify/fedify'
import { Note, Person } from '@fedify/vocab'
import { Store } from './store.ts'
import { buildFederation } from './federation.ts'
import { Follows, FollowError, parseAccount, type FollowsDeps } from './following.ts'
import { RemoteError } from './actors.ts'
import { AS, startFakeRemote, TEST_CONFIG, type FakeRemote } from '../test/fake-remote.ts'

const SITE = 'inner-monologue'
const ME = 'https://ap.test/users/inner-monologue'

let remote: FakeRemote
before(async () => {
  remote = await startFakeRemote()
})
after(() => remote.close())

function setup(overrides: Partial<FollowsDeps> = {}) {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const federation = buildFederation({
    config: TEST_CONFIG, store, kv: new MemoryKvStore(), allowPrivateAddress: true, skipSignatureVerification: true,
  })
  const follows = new Follows({ config: TEST_CONFIG, store, federation, ...overrides })
  const post = (path: string, body: unknown) =>
    federation.fetch(
      new Request(`https://ap.test${path}`, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(body) }),
      { contextData: undefined },
    )
  remote.deliveries.length = 0
  return { store, follows, post }
}

const followOf = (followId: string) => ({ id: followId, type: 'Follow', actor: ME, object: remote.bob.actorId })

test('parses handles and actor URLs', () => {
  const alice = { kind: 'handle', handle: '@alice@social.test' }
  assert.deepEqual(parseAccount('@alice@Social.Test'), alice)
  assert.deepEqual(parseAccount(' alice@social.test '), alice)
  assert.deepEqual(parseAccount('acct:alice@social.test'), alice)
  assert.equal(parseAccount('https://social.test/users/alice')?.kind, 'url')
  assert.equal(parseAccount('http://127.0.0.1:9/users/alice')?.kind, 'url')
  for (const bad of ['', 'alice', '@alice', 'a@b@c', 'http://social.test/users/alice', 'ftp://x.test/a', '@al ice@x.test']) {
    assert.equal(parseAccount(bad), null, bad)
  }
})

test('follows by actor URL, and Accept makes it accepted', async () => {
  const { store, follows, post } = setup()
  const result = await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  assert.equal(result.sent, true)
  assert.equal(result.following.state, 'pending')

  const delivery = remote.deliveries.find((d) => d.type === 'Follow')
  assert.ok(delivery)
  assert.equal(delivery.path, '/users/bob/inbox')
  assert.equal(delivery.body.id, result.following.followId)
  assert.equal(delivery.body.actor, ME)
  assert.equal(delivery.body.object, remote.bob.actorId)

  const cached = store.getActor(remote.bob.actorId)
  assert.equal(cached?.handle, `@bob@${new URL(remote.origin).host}`)
  assert.equal(cached?.name, 'Bob Builder')
  assert.equal(cached?.avatarUrl, `${remote.origin}/avatars/bob.png`)
  assert.equal(cached?.followersUrl, remote.bob.followers)

  const res = await post('/inbox', {
    '@context': AS, id: `${remote.bob.actorId}#accepts/1`, type: 'Accept', actor: remote.bob.actorId, object: followOf(result.following.followId),
  })
  assert.equal(res.status, 202)
  assert.equal(store.getFollowing(SITE, remote.bob.actorId)?.state, 'accepted')

  const again = await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  assert.equal(again.sent, false)
  assert.equal(again.following.state, 'accepted')
})

test('an Accept without our Follow id only counts on the site inbox', async () => {
  const { store, follows, post } = setup()
  await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  const accept = (n: number) => ({
    '@context': AS, id: `${remote.bob.actorId}#accepts/${n}`, type: 'Accept', actor: remote.bob.actorId, object: `${remote.origin}/follows/unknown`,
  })
  await post('/inbox', accept(1))
  assert.equal(store.getFollowing(SITE, remote.bob.actorId)?.state, 'pending')
  await post(`/users/${SITE}/inbox`, accept(2))
  assert.equal(store.getFollowing(SITE, remote.bob.actorId)?.state, 'accepted')
})

test('Reject makes it rejected, and following again sends a new Follow', async () => {
  const { store, follows, post } = setup()
  const first = await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  await post('/inbox', {
    '@context': AS, id: `${remote.bob.actorId}#rejects/1`, type: 'Reject', actor: remote.bob.actorId, object: followOf(first.following.followId),
  })
  assert.equal(store.getFollowing(SITE, remote.bob.actorId)?.state, 'rejected')

  const second = await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  assert.equal(second.sent, true)
  assert.equal(second.following.state, 'pending')
  assert.notEqual(second.following.followId, first.following.followId)
  assert.equal(second.following.createdAt, first.following.createdAt)
})

test('a Reject after Accept means we were removed as a follower', async () => {
  const { store, follows, post } = setup()
  const { following } = await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  await post('/inbox', { '@context': AS, id: `${remote.bob.actorId}#accepts/9`, type: 'Accept', actor: remote.bob.actorId, object: followOf(following.followId) })
  await post('/inbox', { '@context': AS, id: `${remote.bob.actorId}#rejects/9`, type: 'Reject', actor: remote.bob.actorId, object: followOf(following.followId) })
  assert.equal(store.getFollowing(SITE, remote.bob.actorId)?.state, 'rejected')
})

test('answers from someone else are ignored', async () => {
  const { store, follows, post } = setup()
  const { following } = await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  await post('/inbox', { '@context': AS, id: `${remote.actorId}#accepts/1`, type: 'Accept', actor: remote.actorId, object: followOf(following.followId) })
  assert.equal(store.getFollowing(SITE, remote.bob.actorId)?.state, 'pending')
})

test('unfollows by handle with Undo(Follow)', async () => {
  const { store, follows } = setup()
  const { following } = await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  const handle = `@BOB@${new URL(remote.origin).host}`
  assert.equal(await follows.unfollow(SITE, parseAccount(handle)!), true)
  const undo = remote.deliveries.find((d) => d.type === 'Undo')
  assert.ok(undo)
  assert.equal(undo.path, '/users/bob/inbox')
  assert.equal((undo.body.object as Record<string, unknown>).id, following.followId)
  assert.equal(store.getFollowing(SITE, remote.bob.actorId), undefined)
  assert.equal(await follows.unfollow(SITE, parseAccount(remote.bob.actorId)!), false)
})

test('unfollowing a rejected follow sends nothing', async () => {
  const { store, follows } = setup()
  await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  store.setFollowingState(SITE, remote.bob.actorId, 'rejected', new Date())
  remote.deliveries.length = 0
  assert.equal(await follows.unfollow(SITE, parseAccount(remote.bob.actorId)!), true)
  assert.equal(remote.deliveries.length, 0)
})

test('refuses accounts that cannot be followed', async () => {
  const account = parseAccount('@someone@social.test')!
  const code = (c: string) => ({ name: 'FollowError', code: c })
  await assert.rejects(setup({ resolve: async () => null }).follows.follow(SITE, account), code('account_not_found'))
  await assert.rejects(
    setup({ resolve: async () => new Note({ id: new URL('https://social.test/notes/1') }) }).follows.follow(SITE, account),
    code('not_an_actor'),
  )
  const self = new Person({ id: new URL(ME), inbox: new URL(`${ME}/inbox`) })
  await assert.rejects(setup({ resolve: async () => self }).follows.follow(SITE, account), code('cannot_follow_self'))
  const other = new Person({ id: new URL('https://social.test/users/someone'), inbox: new URL('https://social.test/users/someone/inbox') })
  await assert.rejects(setup({ resolve: async () => other, maxFollowing: 0 }).follows.follow(SITE, account), code('following_limit'))
  assert.ok(FollowError)
})

test('reports unreachable and slow servers as RemoteError', async () => {
  const account = parseAccount('@someone@social.test')!
  await assert.rejects(
    setup({ resolve: async () => { throw new Error('ECONNREFUSED') } }).follows.follow(SITE, account),
    (error: unknown) => error instanceof RemoteError && /ECONNREFUSED/.test(error.message),
  )
  await assert.rejects(
    setup({ resolve: () => new Promise(() => {}), timeoutMs: 20 }).follows.follow(SITE, account),
    (error: unknown) => error instanceof RemoteError && /timed out/.test(error.message),
  )
})

test('passes handles to the resolver normalized', async () => {
  const seen: unknown[] = []
  const { follows } = setup({ resolve: async (_siteId, account) => { seen.push(account); return null } })
  await assert.rejects(follows.follow(SITE, parseAccount('acct:Someone@Social.Test')!))
  assert.deepEqual(seen, [{ kind: 'handle', handle: '@Someone@social.test' }])
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test src/following.test.ts`
Expected: FAIL, `Cannot find module '.../src/following.ts'`.

- [ ] **Step 4: Implement `src/actors.ts`**

```ts
import type { Context, DocumentLoader } from '@fedify/fedify'
import { getActorHandle, isActor, Link, type Actor } from '@fedify/vocab'
import { plainText } from './content.ts'
import type { ActorRow, Store } from './store.ts'

export const ACTOR_TTL_MS = 24 * 60 * 60 * 1000
export const LOOKUP_TIMEOUT_MS = 10_000

export class RemoteError extends Error {
  name = 'RemoteError'
}

export async function withTimeout<T>(work: Promise<T>, ms: number = LOOKUP_TIMEOUT_MS, what = 'remote lookup'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RemoteError(`${what} timed out after ${ms / 1000} s`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function hrefOf(value: URL | Link | null | undefined): string | null {
  if (value instanceof URL) return value.href
  if (value instanceof Link) return value.href?.href ?? null
  return null
}

export async function actorRow(actor: Actor, now: Date, options: { documentLoader?: DocumentLoader } = {}): Promise<ActorRow> {
  const id = actor.id!
  const username = actor.preferredUsername?.toString() ?? null
  let handle: string | null
  try {
    handle = await withTimeout(getActorHandle(actor, options))
  } catch {
    handle = username ? `@${username}@${id.host}` : null
  }
  const icon = await actor.getIcon({ ...options, suppressError: true }).catch(() => null)
  return {
    id: id.href,
    handle,
    name: plainText(actor.name?.toString()),
    avatarUrl: hrefOf(icon?.url),
    profileUrl: hrefOf(actor.url),
    inbox: actor.inboxId?.href ?? null,
    sharedInbox: actor.endpoints?.sharedInbox?.href ?? null,
    followersUrl: actor.followersId?.href ?? null,
    fetchedAt: now.toISOString(),
  }
}

export async function ensureActor(
  ctx: Context<void>,
  store: Store,
  siteId: string,
  actorId: URL,
  now: Date,
  known?: Actor,
): Promise<ActorRow | null> {
  const cached = store.getActor(actorId.href)
  if (!known && cached && now.getTime() - Date.parse(cached.fetchedAt) < ACTOR_TTL_MS) return cached
  try {
    const documentLoader = await ctx.getDocumentLoader({ identifier: siteId })
    const actor = known ?? (await withTimeout(ctx.lookupObject(actorId.href, { documentLoader })))
    if (!isActor(actor) || actor.id?.href !== actorId.href) return cached ?? null
    const row = await actorRow(actor, now, { documentLoader })
    store.upsertActor(row)
    return row
  } catch {
    return cached ?? null
  }
}
```

- [ ] **Step 5: Implement `src/following.ts`**

```ts
import type { Federation } from '@fedify/fedify'
import { Follow, Undo, isActor, type Object as APObject } from '@fedify/vocab'
import type { Config } from './config.ts'
import type { FollowingRow, Store } from './store.ts'
import { LOOKUP_TIMEOUT_MS, RemoteError, actorRow, withTimeout } from './actors.ts'

export const MAX_FOLLOWING = 2000

export type Account = { kind: 'handle'; handle: string } | { kind: 'url'; url: URL }

export type FollowErrorCode = 'account_not_found' | 'not_an_actor' | 'cannot_follow_self' | 'following_limit'

export class FollowError extends Error {
  name = 'FollowError'
  code: FollowErrorCode
  constructor(code: FollowErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export type FollowResult = { sent: boolean; following: FollowingRow }

export type Resolver = (siteId: string, account: Account) => Promise<APObject | null>

export type FollowsDeps = {
  config: Config
  store: Store
  federation: Federation<void>
  resolve?: Resolver
  timeoutMs?: number
  maxFollowing?: number
  clock?: () => Date
}

const HANDLE = /^(?:acct:)?@?([^@\s/]+)@([^@\s/]+)$/i

export function parseAccount(input: string): Account | null {
  const value = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return { kind: 'url', url }
    return null
  }
  const match = HANDLE.exec(value)
  return match ? { kind: 'handle', handle: `@${match[1]}@${match[2].toLowerCase()}` } : null
}

export function accountLabel(account: Account): string {
  return account.kind === 'handle' ? account.handle : account.url.href
}

export class Follows {
  deps: FollowsDeps

  constructor(deps: FollowsDeps) {
    this.deps = deps
  }

  context() {
    return this.deps.federation.createContext(this.deps.config.publicUrl, undefined)
  }

  async resolve(siteId: string, account: Account): Promise<APObject | null> {
    if (this.deps.resolve) return this.deps.resolve(siteId, account)
    const ctx = this.context()
    const documentLoader = await ctx.getDocumentLoader({ identifier: siteId })
    return ctx.lookupObject(accountLabel(account), { documentLoader })
  }

  async follow(siteId: string, account: Account): Promise<FollowResult> {
    const { store } = this.deps
    const ctx = this.context()
    const now = this.deps.clock?.() ?? new Date()
    const label = accountLabel(account)

    let object: APObject | null
    try {
      object = await withTimeout(this.resolve(siteId, account), this.deps.timeoutMs ?? LOOKUP_TIMEOUT_MS, `resolving ${label}`)
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError(`could not resolve ${label}: ${(error as Error).message}`)
    }
    if (object === null) throw new FollowError('account_not_found', `no account found for ${label}`)
    if (!isActor(object) || object.id === null || object.inboxId === null) {
      throw new FollowError('not_an_actor', `${label} is not an account`)
    }
    if (ctx.parseUri(object.id)?.type === 'actor') throw new FollowError('cannot_follow_self', "a site can't follow a warmhole account")

    const actorId = object.id.href
    const existing = store.getFollowing(siteId, actorId)
    if (existing?.state === 'accepted') return { sent: false, following: existing }
    const max = this.deps.maxFollowing ?? MAX_FOLLOWING
    if (!existing && store.countFollowing(siteId) >= max) {
      throw new FollowError('following_limit', `this site already follows ${max} accounts`)
    }

    const documentLoader = await ctx.getDocumentLoader({ identifier: siteId })
    const row = await actorRow(object, now, { documentLoader })
    store.upsertActor(account.kind === 'handle' && row.handle === null ? { ...row, handle: account.handle } : row)

    const me = ctx.getActorUri(siteId)
    const followId = new URL(`#follows/${crypto.randomUUID()}`, me)
    store.saveFollowing({
      siteId, actorId, state: 'pending', followId: followId.href, createdAt: now.toISOString(), stateChangedAt: now.toISOString(),
    })
    await ctx.sendActivity({ identifier: siteId }, object, new Follow({ id: followId, actor: me, object: object.id }))
    return { sent: true, following: store.getFollowing(siteId, actorId)! }
  }

  async unfollow(siteId: string, account: Account): Promise<boolean> {
    const { store } = this.deps
    const row =
      account.kind === 'url'
        ? store.getFollowing(siteId, account.url.href)
        : store.listFollowing(siteId).find((f) => store.getActor(f.actorId)?.handle?.toLowerCase() === account.handle.toLowerCase())
    if (!row) return false

    const actor = store.getActor(row.actorId)
    if (row.state !== 'rejected' && actor?.inbox) {
      const ctx = this.context()
      const me = ctx.getActorUri(siteId)
      await ctx.sendActivity(
        { identifier: siteId },
        { id: new URL(actor.id), inboxId: new URL(actor.inbox), endpoints: actor.sharedInbox ? { sharedInbox: new URL(actor.sharedInbox) } : null },
        new Undo({
          id: new URL(`#undos/${crypto.randomUUID()}`, me),
          actor: me,
          object: new Follow({ id: new URL(row.followId), actor: me, object: new URL(row.actorId) }),
        }),
      )
    }
    store.removeFollowing(siteId, row.actorId)
    return true
  }
}
```

- [ ] **Step 6: Implement `src/receive.ts` (follow answers only)**

```ts
import type { InboxContext } from '@fedify/fedify'
import type { Accept, Reject } from '@fedify/vocab'
import { getLogger } from '@logtape/logtape'
import type { Config } from './config.ts'
import type { FollowState, Store } from './store.ts'

const logger = getLogger(['warmhole', 'receive'])

export type ReceiveDeps = { config: Config; store: Store; clock?: () => Date }

export function now(deps: ReceiveDeps): Date {
  return deps.clock?.() ?? new Date()
}

export function drop(reason: string, activity: { id: URL | null }): void {
  logger.debug('dropped {activity}: {reason}', { activity: activity.id?.href, reason })
}

export function receiveFollowAnswer(
  deps: ReceiveDeps,
  ctx: InboxContext<void>,
  activity: Accept | Reject,
  state: 'accepted' | 'rejected',
): void {
  const { store } = deps
  const actorId = activity.actorId?.href
  if (!actorId) return drop('no actor', activity)
  const objectId = activity.objectId?.href
  let row = objectId ? store.findFollowingByFollowId(objectId) : undefined
  if (!row && ctx.recipient !== null) {
    const candidate = store.getFollowing(ctx.recipient, actorId)
    const from: FollowState[] = state === 'accepted' ? ['pending'] : ['pending', 'accepted']
    if (candidate && from.includes(candidate.state)) row = candidate
  }
  if (!row || row.actorId !== actorId) return drop('answers no follow of ours', activity)
  if (row.state === state) return
  store.setFollowingState(row.siteId, row.actorId, state, now(deps))
}
```

- [ ] **Step 7: Register the listeners in `src/federation.ts`**

Add `Accept` (already imported) and `Reject` to the `@fedify/vocab` import, import the handler, and add `clock` to the deps:
```ts
import { receiveFollowAnswer, type ReceiveDeps } from './receive.ts'

export type FederationDeps = {
  config: Config
  store: Store
  kv: KvStore
  queue?: MessageQueue
  allowPrivateAddress?: boolean
  skipSignatureVerification?: boolean
  clock?: () => Date
}
```
In `buildFederation`, destructure `clock` too, build `const receive: ReceiveDeps = { config, store, clock }`, and chain after the existing `.on(Undo, ...)`:
```ts
    .on(Accept, (ctx, accept) => receiveFollowAnswer(receive, ctx, accept, 'accepted'))
    .on(Reject, (ctx, reject) => receiveFollowAnswer(receive, ctx, reject, 'rejected'))
```

- [ ] **Step 8: Run tests and typecheck**

Run: `node --test src/following.test.ts && npm test && npm run typecheck`
Expected: PASS. Fedify notes: `getActorHandle` may live in `@fedify/fedify` rather than `@fedify/vocab`; `ctx.getDocumentLoader({ identifier })` is the authenticated loader, and if it refuses `http://127.0.0.1` despite `allowPrivateAddress`, pass `{ documentLoader: ctx.documentLoader }` in tests through an injected option rather than weakening production code. `ctx.recipient` is the identifier for a personal inbox and `null` for the shared inbox. `Accept.objectId` is the embedded `Follow`'s id when it is embedded.

- [ ] **Step 9: Commit**

```bash
git add src/actors.ts src/following.ts src/receive.ts src/federation.ts src/following.test.ts test/fake-remote.ts
git commit -m "feat: follow and unfollow remote accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Keeping what arrives

**Files:**
- Modify: `src/receive.ts`, `src/federation.ts`
- Test: `src/receive.test.ts`

**Interfaces:**
- Consumes: `Store` (store), `ensureActor`, `withTimeout` (actors), `normalizeObject` (objects)
- Produces (in `src/receive.ts`):
  ```ts
  export function receiveCreate(deps: ReceiveDeps, ctx: InboxContext<void>, create: Create): Promise<void>
  export function receiveUpdate(deps: ReceiveDeps, ctx: InboxContext<void>, update: Update): Promise<void>
  export function receiveDelete(deps: ReceiveDeps, ctx: InboxContext<void>, del: Delete): void
  export function receiveAnnounce(deps: ReceiveDeps, ctx: InboxContext<void>, announce: Announce): Promise<void>
  export function removeBoost(deps: ReceiveDeps, undo: Undo): boolean
  ```

- [ ] **Step 1: Write the failing tests**

`src/receive.test.ts`:
```ts
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryKvStore } from '@fedify/fedify'
import { Store } from './store.ts'
import { buildFederation } from './federation.ts'
import { AS, PUBLIC, startFakeRemote, TWO_SITE_CONFIG, type FakeRemote } from '../test/fake-remote.ts'
import { following } from '../test/items.ts'

const SITE = 'inner-monologue'
const ME = 'https://ap.test/users/inner-monologue'

let remote: FakeRemote
before(async () => {
  remote = await startFakeRemote()
})
after(() => remote.close())

function setup() {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const federation = buildFederation({
    config: TWO_SITE_CONFIG, store, kv: new MemoryKvStore(), allowPrivateAddress: true, skipSignatureVerification: true,
  })
  store.saveFollowing(following(remote.bob.actorId, 'accepted', 0, `${ME}#follows/bob`))
  store.saveFollowing({ ...following(remote.bob.actorId, 'accepted', 0, 'https://ap.test/users/quiet#follows/bob'), siteId: 'quiet' })
  const post = (body: unknown, path = '/inbox') =>
    federation.fetch(
      new Request(`https://ap.test${path}`, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(body) }),
      { contextData: undefined },
    )
  const items = (siteId = SITE) => store.listItems(siteId, { order: 'asc', afterSeq: null, since: null, until: null, limit: 100 })
  return { store, post, items }
}

let n = 0
function note(overrides: Record<string, unknown> = {}, by = remote.bob) {
  n++
  return {
    id: `${by.actorId}/statuses/${n}`,
    type: 'Note',
    attributedTo: by.actorId,
    to: [PUBLIC],
    cc: [by.followers],
    content: `<p>Hello ${n}</p>`,
    published: '2026-10-16T06:00:00Z',
    ...overrides,
  }
}

function create(object: Record<string, unknown>, actor = remote.bob.actorId, suffix = 'activity') {
  return { '@context': AS, id: `${object.id}/${suffix}`, type: 'Create', actor, object }
}

test('keeps a public note from a followed account, for reading sites only', async () => {
  const { store, post, items } = setup()
  const object = note()
  assert.equal((await post(create(object))).status, 202)
  const [item] = items()
  assert.equal(item.objectId, object.id)
  assert.equal(item.authorId, remote.bob.actorId)
  assert.equal(item.visibility, 'public')
  assert.equal(item.contentText, object.content.replace(/<\/?p>/g, ''))
  assert.equal(item.boost, null)
  assert.equal(store.getActor(remote.bob.actorId)?.name, 'Bob Builder')
  assert.equal(items('quiet').length, 0)
})

test('drops posts from accounts not followed or not yet accepted', async () => {
  const { store, post, items } = setup()
  await post(create(note({}, remote.alice), remote.alice.actorId))
  store.setFollowingState(SITE, remote.bob.actorId, 'pending', new Date())
  await post(create(note()))
  assert.equal(items().length, 0)
})

test('keeps followers-only posts and drops direct messages', async () => {
  const { post, items } = setup()
  await post(create(note({ to: [remote.bob.followers], cc: [] })))
  await post(create(note({ to: [ME], cc: [] })))
  assert.deepEqual(items().map((i) => i.visibility), ['followers'])
})

test('drops objects from another origin or attributed to someone else', async () => {
  const { post, items } = setup()
  await post(create(note({ id: 'https://elsewhere.test/notes/1' })))
  await post(create(note({ attributedTo: remote.alice.actorId })))
  assert.equal(items().length, 0)
})

test('stores an object once, however often it arrives', async () => {
  const { post, items } = setup()
  const object = note()
  await post(create(object))
  await post(create(object, remote.bob.actorId, 'again'))
  assert.equal(items().length, 1)
})

test('applies Update from the author only, without moving the item', async () => {
  const { post, items } = setup()
  const object = note()
  await post(create(object))
  const before = items()[0]
  const update = (actor: string, content: string, id: string) => ({
    '@context': AS, id, type: 'Update', actor, object: { ...object, content, updated: '2026-10-16T07:00:00Z' },
  })
  await post(update(remote.alice.actorId, '<p>Hijacked</p>', `${object.id}#update-alice`))
  assert.equal(items()[0].contentText, before.contentText)
  await post(update(remote.bob.actorId, '<p>Edited</p>', `${object.id}#update-1`))
  const after = items()[0]
  assert.equal(after.contentText, 'Edited')
  assert.equal(after.updated, '2026-10-16T07:00:00.000Z')
  assert.equal(after.seq, before.seq)
  assert.equal(after.receivedAt, before.receivedAt)
})

test('Delete tombstones, and a later Create does not bring it back', async () => {
  const { store, post, items } = setup()
  const object = note()
  await post(create(object))
  await post({ '@context': AS, id: `${object.id}#delete`, type: 'Delete', actor: remote.bob.actorId, object: { id: object.id, type: 'Tombstone' } })
  assert.ok(store.getItem(SITE, object.id)?.deletedAt)
  await post(create(object, remote.bob.actorId, 'late'))
  assert.ok(store.getItem(SITE, object.id)?.deletedAt)
  assert.equal(items().length, 0)
})

test('keeps boosts, and removes them on Undo(Announce)', async () => {
  const { store, post, items } = setup()
  const original = note({ to: [PUBLIC], cc: [] }, remote.alice)
  remote.objects.set(new URL(original.id).pathname, { '@context': AS, ...original })
  const announceId = `${remote.bob.actorId}/statuses/boost-${n}/activity`
  const announce = { '@context': AS, id: announceId, type: 'Announce', actor: remote.bob.actorId, object: original.id, published: '2026-10-16T05:58:41Z', to: [PUBLIC] }
  await post(announce)
  const [item] = items()
  assert.equal(item.objectId, original.id)
  assert.equal(item.authorId, remote.alice.actorId)
  assert.deepEqual(item.boost, { actorId: remote.bob.actorId, activityId: announceId, boostedAt: '2026-10-16T05:58:41.000Z' })
  assert.equal(store.getActor(remote.alice.actorId)?.name, 'Alice')

  await post({ '@context': AS, id: `${announceId}#undo`, type: 'Undo', actor: remote.bob.actorId, object: announce })
  assert.equal(items().length, 0)
  assert.equal(store.getItem(SITE, original.id), undefined)
})

test('a boost of something already kept changes nothing; a Create after a boost upgrades it', async () => {
  const { store, post, items } = setup()
  const own = note()
  await post(create(own))
  await post({ '@context': AS, id: `${own.id}/boost`, type: 'Announce', actor: remote.bob.actorId, object: own.id, to: [PUBLIC] })
  assert.equal(items()[0].boost, null)

  store.saveFollowing(following(remote.alice.actorId, 'accepted', 1, `${ME}#follows/alice`))
  const original = note({ to: [PUBLIC], cc: [] }, remote.alice)
  remote.objects.set(new URL(original.id).pathname, { '@context': AS, ...original })
  await post({ '@context': AS, id: `${original.id}/boosted-by-bob`, type: 'Announce', actor: remote.bob.actorId, object: original.id, to: [PUBLIC] })
  const boosted = store.getItem(SITE, original.id)!
  assert.equal(boosted.boost?.actorId, remote.bob.actorId)
  await post(create(original, remote.alice.actorId))
  const upgraded = store.getItem(SITE, original.id)!
  assert.equal(upgraded.boost, null)
  assert.equal(upgraded.seq, boosted.seq)
})

test('drops boosts of followers-only posts', async () => {
  const { post, items } = setup()
  const original = note({ to: [remote.alice.followers], cc: [] }, remote.alice)
  remote.objects.set(new URL(original.id).pathname, { '@context': AS, ...original })
  await post({ '@context': AS, id: `${original.id}/boost`, type: 'Announce', actor: remote.bob.actorId, object: original.id, to: [PUBLIC] })
  assert.equal(items().length, 0)
})

test('a personal inbox only stores for its own site', async () => {
  const { post, items } = setup()
  await post(create(note()), '/users/quiet/inbox')
  assert.equal(items().length, 0)
  assert.equal(items('quiet').length, 0)
})

test('Delete of an account removes its posts and the follow', async () => {
  const { store, post, items } = setup()
  await post(create(note()))
  await post({ '@context': AS, id: `${remote.bob.actorId}#delete`, type: 'Delete', actor: remote.bob.actorId, object: remote.bob.actorId })
  assert.equal(items().length, 0)
  assert.equal(store.getFollowing(SITE, remote.bob.actorId), undefined)
  assert.equal(store.getActor(remote.bob.actorId), undefined)
})

test('Update of an account refreshes its cached profile', async () => {
  const { store, post } = setup()
  await post(create(note()))
  await post({
    '@context': AS, id: `${remote.bob.actorId}#update-profile`, type: 'Update', actor: remote.bob.actorId,
    object: { ...remote.bob.document(), '@context': undefined, name: 'Robert' },
  })
  assert.equal(store.getActor(remote.bob.actorId)?.name, 'Robert')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/receive.test.ts`
Expected: FAIL, the first test finds no items (activities are still dropped).

- [ ] **Step 3: Implement the handlers**

Append to `src/receive.ts` (and extend its imports as shown):
```ts
import type { Announce, Create, Delete, Undo, Update } from '@fedify/vocab'
import { isActor } from '@fedify/vocab'
import { ensureActor, withTimeout } from './actors.ts'
import { normalizeObject } from './objects.ts'

function readingSites(deps: ReceiveDeps): string[] {
  return deps.config.sites.filter((s) => s.readerToken !== undefined).map((s) => s.id)
}

function targetSites(deps: ReceiveDeps, ctx: InboxContext<void>, actorId: URL): string[] {
  const followed = new Set(deps.store.sitesFollowing(actorId.href))
  return readingSites(deps).filter((id) => followed.has(id) && (ctx.recipient === null || ctx.recipient === id))
}

function isoOr(instant: Temporal.Instant | null, fallback: Date): string {
  return new Date(instant?.epochMilliseconds ?? fallback.getTime()).toISOString()
}

export async function receiveCreate(deps: ReceiveDeps, ctx: InboxContext<void>, create: Create): Promise<void> {
  const { store } = deps
  const actorId = create.actorId
  const objectId = create.objectId
  if (!actorId || !objectId) return drop('no actor or object', create)
  if (objectId.origin !== actorId.origin) return drop('object on another origin', create)
  const sites = targetSites(deps, ctx, actorId)
  if (sites.length === 0) return drop('actor not followed', create)

  const at = now(deps)
  const documentLoader = await ctx.getDocumentLoader({ identifier: sites[0] })
  const object = await create.getObject({ documentLoader, suppressError: true }).catch(() => null)
  if (!object || object.id?.href !== objectId.href) return drop('object unavailable', create)
  if (object.attributionId?.href !== actorId.href) return drop('object attributed to someone else', create)

  const author = await ensureActor(ctx, store, sites[0], actorId, at)
  if (!author) return drop('author unavailable', create)
  const draft = await normalizeObject(object, { followersUrl: author.followersUrl, now: at, documentLoader })
  if (!draft) return drop('unsupported object', create)
  if (draft.visibility === 'direct') return drop('direct message', create)
  for (const siteId of sites) store.receiveDirect(siteId, draft, at)
}

export async function receiveAnnounce(deps: ReceiveDeps, ctx: InboxContext<void>, announce: Announce): Promise<void> {
  const { store } = deps
  const actorId = announce.actorId
  const objectId = announce.objectId
  if (!actorId || !objectId || !announce.id) return drop('no actor, object or id', announce)
  const sites = targetSites(deps, ctx, actorId).filter((siteId) => !store.getItem(siteId, objectId.href))
  if (sites.length === 0) return drop('booster not followed, or object already kept', announce)

  const at = now(deps)
  const documentLoader = await ctx.getDocumentLoader({ identifier: sites[0] })
  const object = await withTimeout(ctx.lookupObject(objectId.href, { documentLoader })).catch(() => null)
  if (!object || object.id?.href !== objectId.href) return drop('boosted object unavailable', announce)
  const authorId = object.attributionId
  if (!authorId || authorId.origin !== objectId.origin) return drop('boosted object attributed across origins', announce)

  const author = await ensureActor(ctx, store, sites[0], authorId, at)
  const booster = await ensureActor(ctx, store, sites[0], actorId, at)
  if (!author || !booster) return drop('author or booster unavailable', announce)
  const draft = await normalizeObject(object, { followersUrl: author.followersUrl, now: at, documentLoader })
  if (!draft) return drop('unsupported object', announce)
  if (draft.visibility !== 'public' && draft.visibility !== 'unlisted') return drop('boost of a non-public post', announce)

  const boost = { actorId: actorId.href, activityId: announce.id.href, boostedAt: isoOr(announce.published, at) }
  for (const siteId of sites) store.receiveBoost(siteId, draft, boost, at)
}

export async function receiveUpdate(deps: ReceiveDeps, ctx: InboxContext<void>, update: Update): Promise<void> {
  const { store } = deps
  const actorId = update.actorId
  const objectId = update.objectId
  if (!actorId || !objectId) return drop('no actor or object', update)
  if (objectId.origin !== actorId.origin) return drop('object on another origin', update)
  const at = now(deps)

  if (objectId.href === actorId.href) {
    const siteId = ctx.recipient ?? readingSites(deps)[0]
    if (!siteId || !store.getActor(actorId.href)) return drop('actor not cached', update)
    const object = await update.getObject({ suppressError: true }).catch(() => null)
    if (isActor(object)) await ensureActor(ctx, store, siteId, actorId, at, object)
    return
  }

  const siteIds = store.siteIdsWithObject(objectId.href, actorId.href)
  if (siteIds.length === 0) return drop('object not kept, or not by this actor', update)
  const documentLoader = await ctx.getDocumentLoader({ identifier: siteIds[0] })
  const object = await update.getObject({ documentLoader, suppressError: true }).catch(() => null)
  if (!object || object.id?.href !== objectId.href || object.attributionId?.href !== actorId.href) return drop('object unavailable', update)
  const author = await ensureActor(ctx, store, siteIds[0], actorId, at)
  const draft = await normalizeObject(object, { followersUrl: author?.followersUrl ?? null, now: at, documentLoader })
  if (!draft) return drop('unsupported object', update)
  if (draft.visibility === 'direct') store.tombstoneObject(objectId.href, actorId.href, at)
  else store.updateObject(objectId.href, actorId.href, draft)
}

export function receiveDelete(deps: ReceiveDeps, _ctx: InboxContext<void>, del: Delete): void {
  const { store } = deps
  const actorId = del.actorId?.href
  const objectId = del.objectId?.href
  if (!actorId || !objectId) return drop('no actor or object', del)
  const at = now(deps)
  if (objectId === actorId) {
    store.tombstoneAuthor(actorId, at)
    store.removeFollowingOfActor(actorId)
    store.deleteActor(actorId)
    return
  }
  store.tombstoneObject(objectId, actorId, at)
}

export function removeBoost(deps: ReceiveDeps, undo: Undo): boolean {
  if (!undo.objectId || !undo.actorId) return false
  return deps.store.removeBoost(undo.objectId.href, undo.actorId.href) > 0
}
```

- [ ] **Step 4: Register the listeners in `src/federation.ts`**

Add `Announce` to the `@fedify/vocab` import and the new handlers to the `./receive.ts` import. Make the first line of the existing `Undo` listener:
```ts
      if (removeBoost(receive, undo)) return
```
and chain after the `Reject` listener:
```ts
    .on(Create, (ctx, create) => receiveCreate(receive, ctx, create))
    .on(Update, (ctx, update) => receiveUpdate(receive, ctx, update))
    .on(Delete, (ctx, del) => receiveDelete(receive, ctx, del))
    .on(Announce, (ctx, announce) => receiveAnnounce(receive, ctx, announce))
```

- [ ] **Step 5: Run tests and typecheck**

Run: `node --test src/receive.test.ts && npm test && npm run typecheck`
Expected: PASS, including v1's `other activities are accepted and ignored`. Fedify notes: Fedify skips an inbox activity whose id it has already processed, which is why the duplicate tests use new activity ids for the same object. If `create.getObject()` refetches a same-origin embedded object (its `crossOrigin` handling), the fake remote doesn't serve it and the test fails: then pass the option that trusts same-origin embedded objects, since the origin check above already ran. If Fedify parses `"object": "<actor id>"` in the account `Delete` test as an actor and `objectId` is null, read it from `del.objectIds[0]`.

- [ ] **Step 6: Commit**

```bash
git add src/receive.ts src/federation.ts src/receive.test.ts
git commit -m "feat: keep posts, edits, deletes and boosts from followed accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Reader API

**Files:**
- Create: `src/auth.ts`, `src/reader.ts`, `test/contract.ts`
- Modify: `src/app.ts`, `src/app.test.ts`
- Test: `src/auth.test.ts`, `src/reader.test.ts`

**Interfaces:**
- Consumes: `Store`, `ItemRow`, `FollowingRow`, `FollowState` (store); `Follows`, `FollowError`, `parseAccount`, `Account`, `FollowResult` (following); `RemoteError` (actors); `Config`
- Produces:
  ```ts
  // src/auth.ts
  export function sameToken(given: string, expected: string): boolean
  export function bearerToken(header: string | undefined): string
  export class WindowLimiter {
    constructor(limit: number, windowMs: number)
    retryAfter(key: string, now?: number): number
    hit(key: string, now?: number): void
  }
  // src/reader.ts
  export type ReaderFollows = { follow(siteId: string, account: Account): Promise<FollowResult>; unfollow(siteId: string, account: Account): Promise<boolean> }
  export type ReaderDeps = { config: Config; store: Store; follows: ReaderFollows; clientKey?: (c: Context) => string }
  export type Cursor = { v: 1; o: 'asc' | 'desc'; s: number; a: string | null; b: string | null }
  export function encodeCursor(cursor: Cursor): string
  export function decodeCursor(value: string): Cursor | null
  export function itemJson(store: Store, row: ItemRow): Record<string, unknown>
  export function buildReader(deps: ReaderDeps): Hono
  // src/app.ts
  export type AppDeps = { ...v1, reader?: Hono }
  // test/contract.ts
  export function assertMatches(schema: string, value: unknown): void
  ```

- [ ] **Step 1: Install the contract validator**

Run:
```bash
npm install --save-dev ajv@^8.17.1 ajv-formats@^3.0.1
```
Expected: `package.json` and `package-lock.json` updated.

- [ ] **Step 2: Write `test/contract.ts`**

```ts
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const doc = JSON.parse(readFileSync(new URL('../docs/reader-api.openapi.json', import.meta.url), 'utf-8'))
const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats(ajv)
ajv.addSchema({ ...doc, $id: 'openapi' })

export function assertMatches(schema: string, value: unknown): void {
  const validate = ajv.getSchema(`openapi#/components/schemas/${schema}`)
  assert.ok(validate, `no schema named ${schema}`)
  assert.ok(validate(value), `${schema}: ${ajv.errorsText(validate.errors)}\n${JSON.stringify(value, null, 2)}`)
}
```

- [ ] **Step 3: Write the failing tests**

`src/auth.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WindowLimiter, bearerToken, sameToken } from './auth.ts'

test('compares tokens and reads bearer headers', () => {
  assert.equal(sameToken('abc', 'abc'), true)
  assert.equal(sameToken('abc', 'abd'), false)
  assert.equal(sameToken('', 'abc'), false)
  assert.equal(bearerToken('Bearer xyz'), 'xyz')
  assert.equal(bearerToken('bearer xyz'), '')
  assert.equal(bearerToken(undefined), '')
})

test('limits hits per key per window', () => {
  const limiter = new WindowLimiter(2, 60_000)
  limiter.hit('a', 0)
  assert.equal(limiter.retryAfter('a', 1_000), 0)
  limiter.hit('a', 1_000)
  assert.equal(limiter.retryAfter('a', 1_000), 59)
  assert.equal(limiter.retryAfter('b', 1_000), 0)
  assert.equal(limiter.retryAfter('a', 60_000), 0)
})
```

`src/reader.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { Store, type FollowingRow } from './store.ts'
import { buildReader, type ReaderFollows } from './reader.ts'
import { FollowError, type Account, type FollowResult } from './following.ts'
import { RemoteError } from './actors.ts'
import { READER_TOKEN, TWO_SITE_CONFIG } from '../test/fake-remote.ts'
import { ALICE, BOB, CAROL, SITE, actor, at, boost, draft, following } from '../test/items.ts'
import { assertMatches } from '../test/contract.ts'

const auth = { authorization: `Bearer ${READER_TOKEN}` }
type Body = Record<string, any>

function stubFollows(behavior: Partial<ReaderFollows> = {}) {
  const calls: { op: string; siteId: string; account: Account }[] = []
  const follows: ReaderFollows = {
    follow: async (siteId, account) => {
      calls.push({ op: 'follow', siteId, account })
      return behavior.follow ? behavior.follow(siteId, account) : { sent: true, following: following(BOB, 'pending') }
    },
    unfollow: async (siteId, account) => {
      calls.push({ op: 'unfollow', siteId, account })
      return behavior.unfollow ? behavior.unfollow(siteId, account) : true
    },
  }
  return { follows, calls }
}

function setup(behavior: Partial<ReaderFollows> = {}) {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  store.upsertActor(actor(ALICE, 'Alice'))
  store.upsertActor(actor(BOB, 'Bob'))
  store.upsertActor(actor(CAROL, 'Carol'))
  const { follows, calls } = stubFollows(behavior)
  const app = new Hono().route(
    '/reader/v1',
    buildReader({ config: TWO_SITE_CONFIG, store, follows, clientKey: (c) => c.req.header('x-client') ?? 'test' }),
  )
  const url = (path: string, site = SITE) => `https://ap.test/reader/v1/sites/${site}${path}`
  const get = (path: string, headers: Record<string, string> = auth) => app.request(url(path), { headers })
  const send = (method: string, path: string, body?: unknown) =>
    app.request(url(path), {
      method,
      headers: { ...auth, 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
  const seed = (n: number, minute: number) => store.receiveDirect(SITE, draft(n), at(minute))
  return { store, app, url, get, send, seed, calls }
}

async function expectError(res: Response, status: number, code: string, label = '') {
  assert.equal(res.status, status, label)
  const body = await res.json()
  assertMatches('Error', body)
  assert.equal(body.code, code, label)
}

const ids = (body: Body) => body.items.map((i: Body) => String(i.id).split('/').at(-1))

test('answers 401 for missing, wrong and misplaced tokens', async () => {
  const { app, url } = setup()
  const cases: [string, Record<string, string>][] = [
    [url('/items'), {}],
    [url('/items'), { authorization: 'Bearer wrong' }],
    [url('/items'), { authorization: `Bearer ${TWO_SITE_CONFIG.sites[0].syncToken}` }],
    [url('/items', 'nope'), auth],
    [url('/items', 'quiet'), auth],
  ]
  for (const [target, headers] of cases) {
    const res = await app.request(target, { headers })
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="warmhole"')
    await expectError(res, 401, 'unauthorized', target)
  }
})

test('throttles a client after ten failed authentications', async () => {
  const { get } = setup()
  for (let i = 0; i < 10; i++) await get('/items', { authorization: 'Bearer wrong', 'x-client': 'mallory' })
  const blocked = await get('/items', { ...auth, 'x-client': 'mallory' })
  assert.ok(Number(blocked.headers.get('retry-after')) > 0)
  await expectError(blocked, 429, 'rate_limited')
  assert.equal((await get('/items', { ...auth, 'x-client': 'nico' })).status, 200)
})

test('lists items newest first in the contract shape', async () => {
  const { store, get, seed } = setup()
  seed(1, 0)
  store.receiveBoost(SITE, draft(2), boost(CAROL, 'https://other.test/users/carol/statuses/5/activity', 1), at(1))
  const res = await get('/items')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const body = await res.json()
  assertMatches('ItemPage', body)
  assert.deepEqual(ids(body), ['2', '1'])
  assert.equal(body.next_cursor, null)
  assert.deepEqual(body.items[0].boost, {
    by: { id: CAROL, handle: '@carol@other.test', name: 'Carol', avatar_url: 'https://other.test/avatars/carol.png', profile_url: 'https://other.test/@carol' },
    boosted_at: at(1).toISOString(),
    activity_id: 'https://other.test/users/carol/statuses/5/activity',
  })
  assert.deepEqual(body.items[1], {
    id: `${ALICE}/statuses/1`,
    url: 'https://social.test/@alice/1',
    type: 'Note',
    visibility: 'public',
    published: '2026-10-16T06:00:00.000Z',
    updated: null,
    title: null,
    summary: null,
    sensitive: false,
    content_html: '<p>Post 1</p>',
    content_text: 'Post 1',
    language: 'en',
    author: { id: ALICE, handle: '@alice@social.test', name: 'Alice', avatar_url: 'https://social.test/avatars/alice.png', profile_url: 'https://social.test/@alice' },
    boost: null,
    in_reply_to: null,
    attachments: [],
    hashtags: [],
    mentions: [],
    received_at: at(0).toISOString(),
  })
})

test('pages newest first without repeats while items arrive', async () => {
  const { get, seed } = setup()
  for (let i = 1; i <= 5; i++) seed(i, i)
  let body = await (await get('/items?limit=2')).json()
  assert.deepEqual(ids(body), ['5', '4'])
  seed(6, 6)
  body = await (await get(`/items?limit=2&cursor=${body.next_cursor}`)).json()
  assert.deepEqual(ids(body), ['3', '2'])
  body = await (await get(`/items?limit=2&cursor=${body.next_cursor}`)).json()
  assertMatches('ItemPage', body)
  assert.deepEqual(ids(body), ['1'])
  assert.equal(body.next_cursor, null)
})

test('pages oldest first and resumes from the last cursor', async () => {
  const { get, seed } = setup()
  for (let i = 1; i <= 3; i++) seed(i, i)
  let body = await (await get('/items?order=asc&limit=2')).json()
  assert.deepEqual(ids(body), ['1', '2'])
  body = await (await get(`/items?limit=2&cursor=${body.next_cursor}`)).json()
  assert.deepEqual(ids(body), ['3'])
  const resume = body.next_cursor
  assert.equal(typeof resume, 'string')
  body = await (await get(`/items?cursor=${resume}`)).json()
  assert.deepEqual(body.items, [])
  assert.equal(body.next_cursor, resume)
  seed(4, 4)
  body = await (await get(`/items?cursor=${resume}`)).json()
  assert.deepEqual(ids(body), ['4'])
})

test('filters by received_at with since exclusive and until inclusive', async () => {
  const { get, seed } = setup()
  seed(1, 0)
  seed(2, 10)
  seed(3, 20)
  const since = at(0).toISOString()
  const until = at(10).toISOString()
  assert.deepEqual(ids(await (await get(`/items?since=${since}&until=${until}`)).json()), ['2'])
  assert.deepEqual(ids(await (await get('/items?since=2026-10-16T08:05:00%2B02:00')).json()), ['3', '2'])
  const bounded = await (await get(`/items?order=asc&until=${until}`)).json()
  assert.deepEqual(ids(bounded), ['1', '2'])
  assert.equal(bounded.next_cursor, null)
})

test('rejects bad list parameters', async () => {
  const { get, seed } = setup()
  seed(1, 0)
  seed(2, 1)
  const cases: [string, string][] = [
    ['limit=0', 'invalid_request'],
    ['limit=201', 'invalid_request'],
    ['limit=two', 'invalid_request'],
    ['order=sideways', 'invalid_request'],
    ['since=yesterday', 'invalid_request'],
    ['since=2026-10-16T06:00:00', 'invalid_request'],
    [`since=${at(10).toISOString()}&until=${at(0).toISOString()}`, 'invalid_request'],
    ['cursor=nonsense', 'invalid_cursor'],
  ]
  for (const [query, code] of cases) await expectError(await get(`/items?${query}`), 400, code, query)

  const first = await (await get('/items?order=asc&limit=1')).json()
  await expectError(await get(`/items?order=desc&cursor=${first.next_cursor}`), 400, 'invalid_cursor')
  await expectError(await get(`/items?since=${at(0).toISOString()}&cursor=${first.next_cursor}`), 400, 'invalid_cursor')
  assert.equal((await get(`/items?order=asc&cursor=${first.next_cursor}`)).status, 200)
})

test('looks up one item by id', async () => {
  const { store, get, seed } = setup()
  seed(1, 0)
  const id = encodeURIComponent(draft(1).objectId)
  const res = await get(`/items/lookup?id=${id}`)
  assert.equal(res.status, 200)
  assertMatches('Item', await res.json())
  await expectError(await get(`/items/lookup?id=${encodeURIComponent('https://social.test/nope')}`), 404, 'not_found')
  await expectError(await get('/items/lookup'), 400, 'invalid_request')
  store.tombstoneObject(draft(1).objectId, ALICE, at(5))
  await expectError(await get(`/items/lookup?id=${id}`), 410, 'gone')
})

test('lists follows with their state', async () => {
  const { store, get } = setup()
  store.saveFollowing(following(ALICE, 'accepted', 0))
  store.saveFollowing(following(BOB, 'pending', 1))
  const body = await (await get('/following')).json()
  assertMatches('FollowingList', body)
  assert.deepEqual(body.following.map((f: Body) => [f.account.handle, f.state]), [['@alice@social.test', 'accepted'], ['@bob@social.test', 'pending']])
  const pending = await (await get('/following?state=pending')).json()
  assert.deepEqual(pending.following.map((f: Body) => f.account.id), [BOB])
  await expectError(await get('/following?state=maybe'), 400, 'invalid_request')
})

test('follows: 202 when sent, 200 when already accepted', async () => {
  const sent = setup()
  const res = await sent.send('POST', '/following', { account: '@Bob@Social.test' })
  assert.equal(res.status, 202)
  const body = await res.json()
  assertMatches('Following', body)
  assert.equal(body.state, 'pending')
  assert.deepEqual(sent.calls, [{ op: 'follow', siteId: SITE, account: { kind: 'handle', handle: '@Bob@social.test' } }])

  const accepted: FollowingRow = following(BOB, 'accepted')
  const done = setup({ follow: async (): Promise<FollowResult> => ({ sent: false, following: accepted }) })
  const again = await done.send('POST', '/following', { account: BOB })
  assert.equal(again.status, 200)
  assert.equal((await again.json()).state, 'accepted')
})

test('maps follow failures to 422 and 502', async () => {
  const refused = setup({ follow: async () => { throw new FollowError('account_not_found', 'no account found for @x@y.test') } })
  await expectError(await refused.send('POST', '/following', { account: '@x@y.test' }), 422, 'account_not_found')
  const down = setup({ follow: async () => { throw new RemoteError('could not reach y.test') } })
  await expectError(await down.send('POST', '/following', { account: '@x@y.test' }), 502, 'remote_unreachable')
})

test('rejects bad follow bodies', async () => {
  const { send, calls } = setup()
  for (const body of ['not json', {}, { account: 42 }, { account: 'nonsense' }, { account: '@a@b.test', extra: 1 }]) {
    await expectError(await send('POST', '/following', body), 400, 'invalid_request', JSON.stringify(body))
  }
  await expectError(await send('POST', '/following', { account: 'x'.repeat(5000) }), 413, 'payload_too_large')
  assert.deepEqual(calls, [])
})

test('limits follow requests per site', async () => {
  const { send } = setup()
  for (let i = 0; i < 30; i++) assert.equal((await send('POST', '/following', { account: `@user${i}@social.test` })).status, 202)
  const limited = await send('POST', '/following', { account: '@one-more@social.test' })
  assert.ok(Number(limited.headers.get('retry-after')) > 0)
  await expectError(limited, 429, 'rate_limited')
})

test('unfollows by account', async () => {
  const ok = setup()
  const res = await ok.send('DELETE', `/following?account=${encodeURIComponent('@bob@social.test')}`)
  assert.equal(res.status, 204)
  assert.deepEqual(ok.calls, [{ op: 'unfollow', siteId: SITE, account: { kind: 'handle', handle: '@bob@social.test' } }])
  const missing = setup({ unfollow: async () => false })
  await expectError(await missing.send('DELETE', `/following?account=${encodeURIComponent(BOB)}`), 404, 'not_found')
  await expectError(await ok.send('DELETE', '/following'), 400, 'invalid_request')
  await expectError(await ok.send('DELETE', '/following?account=nonsense'), 400, 'invalid_request')
})

test('unknown reader routes are JSON 404s', async () => {
  const { get } = setup()
  await expectError(await get('/nothing'), 404, 'not_found')
})
```

In `src/app.test.ts`, give `setup` a second parameter and pass it through:
```ts
function setup(sync: (siteId: string) => Promise<SyncResult> = async () => ({ new: 1, updated: 0, deleted: 0 }), reader?: Hono) {
```
add `reader,` to the `buildApp({ ... })` call, `import { Hono } from 'hono'` at the top, and append:
```ts
test('mounts the reader under /reader/v1 before Fedify', async () => {
  const reader = new Hono()
  reader.get('/ping', (c) => c.text('pong'))
  const { request } = setup(undefined, reader)
  assert.equal(await (await request('/reader/v1/ping')).text(), 'pong')
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `node --test src/auth.test.ts src/reader.test.ts src/app.test.ts`
Expected: FAIL, `Cannot find module '.../src/auth.ts'`.

- [ ] **Step 5: Implement `src/auth.ts`**

```ts
import { createHash, timingSafeEqual } from 'node:crypto'

export function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function bearerToken(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

export class WindowLimiter {
  limit: number
  windowMs: number
  windows = new Map<string, { start: number; count: number }>()

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  retryAfter(key: string, now = Date.now()): number {
    const w = this.windows.get(key)
    if (!w || now - w.start >= this.windowMs || w.count < this.limit) return 0
    return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000))
  }

  hit(key: string, now = Date.now()): void {
    const w = this.windows.get(key)
    if (w && now - w.start < this.windowMs) {
      w.count++
      return
    }
    this.windows.set(key, { start: now, count: 1 })
    if (this.windows.size > 10_000) {
      for (const [k, old] of this.windows) if (now - old.start >= this.windowMs) this.windows.delete(k)
    }
  }
}
```

In `src/app.ts`, delete the local `sameToken` and the `node:crypto` import, add `import { bearerToken, sameToken } from './auth.ts'`, and in the sync route replace the two `header`/`token` lines with:
```ts
    const token = bearerToken(c.req.header('authorization'))
```

- [ ] **Step 6: Implement `src/reader.ts`**

```ts
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { getLogger } from '@logtape/logtape'
import type { Config } from './config.ts'
import type { FollowState, FollowingRow, ItemRow, Store } from './store.ts'
import { FollowError, parseAccount, type Account, type FollowResult } from './following.ts'
import { RemoteError } from './actors.ts'
import { WindowLimiter, bearerToken, sameToken } from './auth.ts'

const logger = getLogger(['warmhole', 'reader'])
const STATES: FollowState[] = ['pending', 'accepted', 'rejected']
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i
const MAX_BODY = 4096

export type ReaderFollows = {
  follow(siteId: string, account: Account): Promise<FollowResult>
  unfollow(siteId: string, account: Account): Promise<boolean>
}

export type ReaderDeps = { config: Config; store: Store; follows: ReaderFollows; clientKey?: (c: Context) => string }

type Order = 'asc' | 'desc'
export type Cursor = { v: 1; o: Order; s: number; a: string | null; b: string | null }

class ApiError extends Error {
  name = 'ApiError'
  status: ContentfulStatusCode
  code: string
  constructor(status: ContentfulStatusCode, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const invalid = (message: string) => new ApiError(400, 'invalid_request', message)
const badCursor = (message: string) => new ApiError(400, 'invalid_cursor', message)

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function isInstant(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
}

export function decodeCursor(value: string): Cursor | null {
  try {
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'))
    if (c?.v !== 1 || (c.o !== 'asc' && c.o !== 'desc') || !Number.isSafeInteger(c.s) || c.s < 0) return null
    if (!isInstant(c.a) || !isInstant(c.b)) return null
    return { v: 1, o: c.o, s: c.s, a: c.a, b: c.b }
  } catch {
    return null
  }
}

function fail(c: Context, status: ContentfulStatusCode, code: string, message: string): Response {
  return c.json({ error: message, code }, status)
}

function limited(c: Context, seconds: number): Response {
  c.header('Retry-After', String(seconds))
  return fail(c, 429, 'rate_limited', `too many requests, retry in ${seconds} s`)
}

function instant(value: string | undefined, name: string): string | null {
  if (value === undefined) return null
  if (!RFC3339.test(value) || Number.isNaN(Date.parse(value))) throw invalid(`${name} must be an RFC 3339 date-time with a time zone`)
  return new Date(value).toISOString()
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50
  const n = Number(value)
  if (!/^\d{1,3}$/.test(value) || n < 1 || n > 200) throw invalid('limit must be an integer from 1 to 200')
  return n
}

function parseOrder(value: string | undefined): Order | undefined {
  if (value === undefined) return undefined
  if (value !== 'asc' && value !== 'desc') throw invalid('order must be asc or desc')
  return value
}

function accountParam(value: unknown): Account {
  if (typeof value !== 'string' || value === '') throw invalid('account is required')
  if (value.length > 2048) throw invalid('account is too long')
  const account = parseAccount(value)
  if (!account) throw invalid('account must be a handle like @user@host or an https actor URL')
  return account
}

function defaultClientKey(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function accountJson(store: Store, id: string) {
  const a = store.getActor(id)
  return { id, handle: a?.handle ?? null, name: a?.name ?? null, avatar_url: a?.avatarUrl ?? null, profile_url: a?.profileUrl ?? null }
}

export function itemJson(store: Store, row: ItemRow) {
  return {
    id: row.objectId,
    url: row.url,
    type: row.type,
    visibility: row.visibility,
    published: row.published,
    updated: row.updated,
    title: row.title,
    summary: row.summary,
    sensitive: row.sensitive,
    content_html: row.contentHtml,
    content_text: row.contentText,
    language: row.language,
    author: accountJson(store, row.authorId),
    boost: row.boost ? { by: accountJson(store, row.boost.actorId), boosted_at: row.boost.boostedAt, activity_id: row.boost.activityId } : null,
    in_reply_to: row.inReplyTo,
    attachments: row.attachments,
    hashtags: row.hashtags,
    mentions: row.mentions,
    received_at: row.receivedAt,
  }
}

function followingJson(store: Store, row: FollowingRow) {
  return { account: accountJson(store, row.actorId), state: row.state, created_at: row.createdAt, state_changed_at: row.stateChangedAt }
}

type Handler = (c: Context) => Response | Promise<Response>

function handle(fn: Handler): Handler {
  return async (c) => {
    try {
      return await fn(c)
    } catch (error) {
      if (error instanceof ApiError) return fail(c, error.status, error.code, error.message)
      logger.error('reader request failed: {error}', { error })
      return fail(c, 500, 'internal', 'internal error')
    }
  }
}

export function buildReader({ config, store, follows, clientKey = defaultClientKey }: ReaderDeps): Hono {
  const sites = new Map(config.sites.map((s) => [s.id, s]))
  const authFailures = new WindowLimiter(10, 60_000)
  const followRequests = new WindowLimiter(30, 60_000)
  const reader = new Hono()
  const siteOf = (c: Context) => c.req.param('siteId') as string

  reader.use('*', async (c, next) => {
    await next()
    c.res.headers.set('Cache-Control', 'no-store')
  })

  reader.use('/sites/:siteId/*', async (c, next) => {
    const key = clientKey(c)
    const wait = authFailures.retryAfter(key)
    if (wait > 0) return limited(c, wait)
    const site = sites.get(siteOf(c))
    const token = bearerToken(c.req.header('authorization'))
    if (!site?.readerToken || !sameToken(token, site.readerToken)) {
      authFailures.hit(key)
      c.header('WWW-Authenticate', 'Bearer realm="warmhole"')
      return fail(c, 401, 'unauthorized', 'unauthorized')
    }
    await next()
  })

  reader.get(
    '/sites/:siteId/items',
    handle((c) => {
      const q = c.req.query()
      const limit = parseLimit(q.limit)
      let order = parseOrder(q.order)
      let since = instant(q.since, 'since')
      let until = instant(q.until, 'until')
      let afterSeq: number | null = null
      if (q.cursor !== undefined) {
        const cursor = decodeCursor(q.cursor)
        if (!cursor) throw badCursor('cursor is not valid')
        if (order !== undefined && order !== cursor.o) throw badCursor('cursor was made with a different order')
        if (q.since !== undefined && since !== cursor.a) throw badCursor('cursor was made with a different since')
        if (q.until !== undefined && until !== cursor.b) throw badCursor('cursor was made with a different until')
        order = cursor.o
        since = cursor.a
        until = cursor.b
        afterSeq = cursor.s
      }
      const o = order ?? 'desc'
      if (since !== null && until !== null && since >= until) throw invalid('since must be before until')

      const rows = store.listItems(siteOf(c), { order: o, afterSeq, since, until, limit: limit + 1 })
      const page = rows.slice(0, limit)
      const last = page.at(-1)?.seq ?? afterSeq ?? 0
      let next: string | null = null
      if (rows.length > limit || (o === 'asc' && until === null)) next = encodeCursor({ v: 1, o, s: last, a: since, b: until })
      return c.json({ items: page.map((row) => itemJson(store, row)), next_cursor: next })
    }),
  )

  reader.get(
    '/sites/:siteId/items/lookup',
    handle((c) => {
      const id = c.req.query('id')
      if (!id) throw invalid('id is required')
      const row = store.getItem(siteOf(c), id)
      if (!row) throw new ApiError(404, 'not_found', 'item not found')
      if (row.deletedAt !== null) throw new ApiError(410, 'gone', 'item was deleted')
      return c.json(itemJson(store, row))
    }),
  )

  reader.get(
    '/sites/:siteId/following',
    handle((c) => {
      const state = c.req.query('state')
      if (state !== undefined && !STATES.includes(state as FollowState)) throw invalid('state must be pending, accepted or rejected')
      return c.json({ following: store.listFollowing(siteOf(c), state as FollowState | undefined).map((f) => followingJson(store, f)) })
    }),
  )

  reader.post(
    '/sites/:siteId/following',
    bodyLimit({ maxSize: MAX_BODY, onError: (c) => fail(c, 413, 'payload_too_large', `request body is over ${MAX_BODY} bytes`) }),
    handle(async (c) => {
      const siteId = siteOf(c)
      const wait = followRequests.retryAfter(siteId)
      if (wait > 0) return limited(c, wait)
      followRequests.hit(siteId)
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        throw invalid('body must be JSON')
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body must be an object')
      if (Object.keys(body).some((key) => key !== 'account')) throw invalid('body may only contain account')
      const account = accountParam((body as Record<string, unknown>).account)
      try {
        const { sent, following } = await follows.follow(siteId, account)
        return c.json(followingJson(store, following), sent ? 202 : 200)
      } catch (error) {
        if (error instanceof FollowError) throw new ApiError(422, error.code, error.message)
        if (error instanceof RemoteError) throw new ApiError(502, 'remote_unreachable', error.message)
        throw error
      }
    }),
  )

  reader.delete(
    '/sites/:siteId/following',
    handle(async (c) => {
      const account = accountParam(c.req.query('account'))
      if (!(await follows.unfollow(siteOf(c), account))) throw new ApiError(404, 'not_found', 'this site does not follow that account')
      return c.body(null, 204)
    }),
  )

  reader.all('*', (c) => fail(c, 404, 'not_found', 'no such route'))

  return reader
}
```

- [ ] **Step 7: Mount the reader in `src/app.ts`**

Add `reader?: Hono` to `AppDeps`, destructure it in `buildApp`, and directly before `app.use(fedifyMiddleware(federation, () => undefined))` add:
```ts
  if (reader) app.route('/reader/v1', reader)
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: every test PASS, `tsc` silent. Notes: if `tsc` says `Ajv2020` isn't constructable or `addFormats` isn't callable (CommonJS default-export interop under `nodenext`), use `Ajv2020.default` / `addFormats.default` guarded by `?? Ajv2020`. If Hono doesn't expose `:siteId` to the `'/sites/:siteId/*'` middleware, read it with `c.req.path.split('/')[2]` after stripping the mount prefix. If `ContentfulStatusCode` isn't exported by the installed Hono, use `StatusCode`.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/auth.ts src/auth.test.ts src/reader.ts src/reader.test.ts src/app.ts src/app.test.ts test/contract.ts
git commit -m "feat: serve the reader api under /reader/v1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Retention, limits, wiring and docs

**Files:**
- Create: `src/retention.ts`
- Modify: `src/app.ts`, `src/app.test.ts`, `src/server.ts`, `warmhole.example.json`, `README.md`
- Test: `src/retention.test.ts`

**Interfaces:**
- Consumes: `Config` (config), `Store` (store), `Follows` (following), `buildReader` (reader)
- Produces:
  ```ts
  export const DAY_MS: number
  export function pruneExpired(config: Config, store: Store, now?: Date): { items: number; actors: number }
  export function startRetention(config: Config, store: Store, onPrune: (result: { items: number; actors: number }) => void, intervalMs?: number): () => void
  ```

- [ ] **Step 1: Write the failing tests**

`src/retention.test.ts`:
```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Store } from './store.ts'
import { DAY_MS, pruneExpired } from './retention.ts'
import { TWO_SITE_CONFIG } from '../test/fake-remote.ts'
import { ALICE, BOB, CAROL, DAVE, SITE, actor, draft, following } from '../test/items.ts'

test('prunes items past each site retention and actors nobody uses', () => {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const now = new Date('2026-11-30T06:00:00.000Z')
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS)

  store.receiveDirect(SITE, draft(1), ago(31))
  store.receiveDirect(SITE, draft(2), ago(29))
  store.receiveDirect('quiet', draft(3), ago(2))
  store.upsertActor(actor(ALICE, 'Alice', { fetchedAt: ago(40).toISOString() }))
  store.upsertActor(actor(BOB, 'Bob', { fetchedAt: ago(40).toISOString() }))
  store.saveFollowing(following(BOB, 'accepted'))
  store.upsertActor(actor(CAROL, 'Carol', { fetchedAt: ago(40).toISOString() }))
  store.upsertActor(actor(DAVE, 'Dave', { fetchedAt: ago(1).toISOString() }))

  assert.deepEqual(pruneExpired(TWO_SITE_CONFIG, store, now), { items: 2, actors: 1 })
  assert.ok(store.getItem(SITE, draft(2).objectId))
  assert.equal(store.getItem(SITE, draft(1).objectId), undefined)
  assert.equal(store.getItem('quiet', draft(3).objectId), undefined)
  assert.equal(store.getActor(CAROL), undefined)
  assert.ok(store.getActor(ALICE) && store.getActor(BOB) && store.getActor(DAVE))
})
```

Append to `src/app.test.ts`:
```ts
test('inbox bodies over 1 MB are refused', async () => {
  const { request } = setup()
  for (const path of ['/inbox', '/users/inner-monologue/inbox']) {
    const res = await request(path, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: 'x'.repeat(1024 * 1024 + 1) })
    assert.equal(res.status, 413, path)
  }
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/retention.test.ts src/app.test.ts`
Expected: FAIL, `Cannot find module '.../src/retention.ts'`, and the inbox test gets a non-413 status.

- [ ] **Step 3: Implement `src/retention.ts`**

```ts
import type { Config } from './config.ts'
import type { Store } from './store.ts'

export const DAY_MS = 24 * 60 * 60 * 1000

export function pruneExpired(config: Config, store: Store, now: Date = new Date()): { items: number; actors: number } {
  let items = 0
  for (const site of config.sites) {
    items += store.prune(site.id, new Date(now.getTime() - site.retentionDays * DAY_MS).toISOString())
  }
  const longest = Math.max(...config.sites.map((s) => s.retentionDays))
  const actors = store.pruneActors(new Date(now.getTime() - longest * DAY_MS).toISOString())
  return { items, actors }
}

export function startRetention(
  config: Config,
  store: Store,
  onPrune: (result: { items: number; actors: number }) => void,
  intervalMs = 60 * 60 * 1000,
): () => void {
  const run = () => onPrune(pruneExpired(config, store))
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
```

- [ ] **Step 4: Limit inbox bodies in `src/app.ts`**

Add `import { bodyLimit } from 'hono/body-limit'` and, directly before the reader mount, add:
```ts
  const inboxLimit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'activity is over 1 MB' }, 413) })
  app.use('/inbox', inboxLimit)
  app.use('/users/:id/inbox', inboxLimit)
```

- [ ] **Step 5: Wire everything in `src/server.ts`**

Add the imports:
```ts
import { Follows } from './following.ts'
import { buildReader } from './reader.ts'
import { startRetention } from './retention.ts'
```
Replace the `const app = ...` line with:
```ts
const follows = new Follows({ config, store, federation })
const reader = buildReader({ config, store, follows })
const app = buildApp({ config, federation, syncer: new Syncer({ config, store, federation }), reader })

startRetention(config, store, ({ items, actors }) => {
  if (items > 0 || actors > 0) logger.info('pruned {items} items and {actors} actors', { items, actors })
})
```

- [ ] **Step 6: Update `warmhole.example.json`**

Add to the site, after `"syncTokenEnv"`:
```json
      "readerTokenEnv": "MY_BLOG_READER_TOKEN",
      "retentionDays": 30,
```

- [ ] **Step 7: Update `README.md`**

Replace "Likes, boosts and replies are ignored for now." in "How it works" with:
```markdown
Your account can also follow other fediverse accounts. warmhole keeps what
they post for a private reader of your choice (see "Read what you follow").
Likes and replies to your posts are ignored for now.
```

Add a section after "Connect a site":
````markdown
## Read what you follow

Give a site a reader token to let it follow accounts and keep their posts:

1. Set `readerTokenEnv` (and optionally `retentionDays`, default 30) on the
   site, and set that variable to a random token of at least 32 characters,
   different from the sync token: `openssl rand -hex 32`.
2. Follow someone:

   ```bash
   curl --fail -X POST -H "Authorization: Bearer $READER_TOKEN" \
     -H 'Content-Type: application/json' -d '{"account":"@alice@mastodon.social"}' \
     https://ap.example.dev/reader/v1/sites/my-blog/following
   ```

3. Read what arrived since yesterday morning:

   ```bash
   curl --fail -H "Authorization: Bearer $READER_TOKEN" \
     'https://ap.example.dev/reader/v1/sites/my-blog/items?since=2026-10-15T06:00:00Z'
   ```

The full contract is [`docs/reader-api.openapi.json`](docs/reader-api.openapi.json).
Posts are kept for `retentionDays`, including followers-only posts from the
accounts you follow, so keep the reader token private. Direct messages are
never kept. Media stays on the original servers.
````

- [ ] **Step 8: Run the full suite, typecheck and the smoke test**

Run: `npm test && npm run typecheck`
Expected: every test PASS, `tsc` silent.

Then run the v1 Task 7 smoke test with `"readerTokenEnv":"SMOKE_READER"` added to the site and `SMOKE_READER=$(openssl rand -hex 32)` in the environment, plus:
```bash
curl -fsS -H "Authorization: Bearer $SMOKE_READER" localhost:8080/reader/v1/sites/inner-monologue/items
curl -sS -o /dev/null -w '%{http_code}\n' localhost:8080/reader/v1/sites/inner-monologue/items
```
Expected: `{"items":[],"next_cursor":null}`, then `401`.

- [ ] **Step 9: Commit**

```bash
git add src/retention.ts src/retention.test.ts src/app.ts src/app.test.ts src/server.ts warmhole.example.json README.md
git commit -m "feat: prune old items, limit inbox bodies and document the reader

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 10: Manual end-to-end check (human, after deploying)**

Not automated; record the results in the PR description:
1. Deploy with `readerTokenEnv` set for the Inner Monologue.
2. `POST /reader/v1/sites/inner-monologue/following` with a test Mastodon account's handle: 202, `pending`; within seconds `GET /following` shows `accepted`, and the Mastodon account lists the site as a follower.
3. From the test account, post publicly, followers-only, and a direct message to `@nico@innermonologue.nbaglivo.dev`; boost someone else's public post. `GET /items` shows the first two and the boost (with `boost.by`), not the direct message.
4. Edit the public post; `GET /items/lookup?id=` shows the new content and `updated`. Delete it; the lookup answers 410.
5. Page `GET /items?order=asc&limit=1` to the end, keep `next_cursor`, post again, and check the stored cursor returns exactly the new post.
6. `DELETE /following?account=` for the test account: 204, and the Mastodon account no longer lists the site as a follower.

### Task 9: Readable logs for following

Added after v1 gained short readable logs (`a7def4a`, `5b15ee6`). Follow state changes are the events an operator watches after `POST /following`, so they log at `info` in the same style as `warmhole.followers`, and `scripts/logs` must name the new outgoing activities.

**Files:**
- Modify: `src/following.ts`, `src/receive.ts`, `src/logview.ts`, `.env.example`
- Test: `src/following.test.ts`, `src/logview.test.ts`

**Interfaces:**
- Consumes: `Follows.follow`, `Follows.unfollow` (Task 5), `receiveFollowAnswer` (Task 5), `captureLogs` (`test/logs.ts`), `describeLine` (`src/logview.ts`)
- Produces: logger category `warmhole.following`; no new exports

- [ ] **Step 1: Write the failing tests**

In `src/following.test.ts`, add `import { captureLogs } from '../test/logs.ts'` and:
```ts
test('follow state changes are logged as short lines', async () => {
  const logs = await captureLogs()
  const { follows, post } = setup()
  const first = await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  await post('/inbox', {
    '@context': AS, id: `${remote.bob.actorId}#accepts/1`, type: 'Accept', actor: remote.bob.actorId, object: followOf(first.following.followId),
  })
  await follows.follow(SITE, parseAccount(remote.bob.actorId)!)
  await post('/inbox', {
    '@context': AS, id: `${remote.bob.actorId}#rejects/1`, type: 'Reject', actor: remote.bob.actorId, object: followOf(first.following.followId),
  })
  await follows.unfollow(SITE, parseAccount(remote.bob.actorId)!)
  assert.deepEqual(logs.lines('warmhole.following'), [
    `${SITE} asked to follow ${remote.bob.actorId}`,
    `${remote.bob.actorId} accepted ${SITE}`,
    `${remote.bob.actorId} rejected ${SITE}`,
    `${SITE} unfollowed ${remote.bob.actorId}`,
  ])
})
```
The second `follow` is `accepted` already, sends nothing and logs nothing.

In `src/logview.test.ts`:
```ts
test('follows and unfollows sent to others are named', () => {
  const sent = (activityId: string) => line({
    logger: 'fedify.federation.outbox',
    message: 'Successfully sent activity ...',
    properties: { activityId, inbox: 'https://mastodon.social/users/alice/inbox' },
  })
  assert.equal(describeLine(sent('https://ap.test/users/inner-monologue#follows/3f2a-77'), 'UTC'), '12:43:49 sent Follow → mastodon.social')
  assert.equal(describeLine(sent('https://ap.test/users/inner-monologue#undos/9c1d'), 'UTC'), '12:43:49 sent Undo → mastodon.social')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/following.test.ts src/logview.test.ts`
Expected: FAIL. The log lines are `[]`, and the activities show as `sent Follows/3f2a → …` and `sent Undos/9c1d → …`.

- [ ] **Step 3: Log follow state changes**

Use `getLogger(['warmhole', 'following'])` in both files, at `info`, with the actor id and site id as properties named `actor` and `site`:
- `Follows.follow`, only when a `Follow` is sent: `'{site} asked to follow {actor}'`
- `receiveFollowAnswer`, after `setFollowingState`: `'{actor} accepted {site}'` or `'{actor} rejected {site}'`
- `Follows.unfollow`, after the row is removed: `'{site} unfollowed {actor}'`

Leave `drop` at `debug`: dropped activities are routine and would drown the log.

- [ ] **Step 4: Name `follows/` and `undos/` in `activityKind` (`src/logview.ts`)**

Map the fragment's first `/` segment through `{ accepts: 'Accept', follows: 'Follow', undos: 'Undo' }` and fall back to the existing `split('-')` rule for v1's `#create`, `#update-…` and `#delete` ids.

- [ ] **Step 5: Add the reader token to `.env.example`**

```
MY_BLOG_READER_TOKEN=replace-with-openssl-rand-hex-32
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: every test PASS, `tsc` silent.

- [ ] **Step 7: Commit**

```bash
git add src/following.ts src/receive.ts src/following.test.ts src/logview.ts src/logview.test.ts .env.example
git commit -m "feat: log follow state changes in short readable lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
