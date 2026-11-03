import type { Config, SiteConfig } from './config.ts'
import type { PostRow } from './store.ts'

export type RenderedEmail = { subject: string; html: string; text: string }

const BG = '#faf8f4'
const INK = '#38352f'
const SANS = '"IBM Plex Sans", -apple-system, "Segoe UI", Roboto, sans-serif'
const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace'
const FONT_BASE = 'https://nbaglivo.dev/public/fonts'

const FONT_FACES = [
  ...[300, 400, 500].map(
    (w) =>
      `@font-face{font-family:"IBM Plex Sans";font-weight:${w};font-style:normal;src:url(${FONT_BASE}/ibm-plex-sans/ibm-plex-sans-latin-${w}-normal.woff2) format("woff2")}`,
  ),
  `@font-face{font-family:"IBM Plex Mono";font-weight:400;font-style:normal;src:url(${FONT_BASE}/ibm-plex-mono/ibm-plex-mono-latin-400-normal.woff2) format("woff2")}`,
].join('')

const LINK = `color:${INK};text-decoration:none;border-bottom:2px dotted #cfc7b8;font-weight:500`
const SITE_NAME = `font-family:${MONO};font-size:12.5px;color:#726d62;margin:0 0 28px`
const TITLE = `font-family:${SANS};font-size:30px;font-weight:300;letter-spacing:-.01em;line-height:1.25;color:${INK};margin:0 0 8px`
const BODY = `font-family:${SANS};font-size:16.5px;line-height:1.7;color:${INK}`
const FOOTER = `font-family:${SANS};font-size:14px;line-height:1.7;color:#6f6a60;border-top:1px solid #ebe6dc;padding-top:20px;margin-top:52px`
const BUTTON = `display:inline-block;background:${INK};color:${BG};padding:10px 18px;border:0;border-radius:0;font-family:${SANS};font-size:16.5px;text-decoration:none`

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', nbsp: ' ', amp: '&' }

function decodeEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (match, hex, dec, name) => {
    if (hex !== undefined || dec !== undefined) {
      const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10)
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    if (name === 'apos') return "'"
    return NAMED_ENTITIES[name.toLowerCase()] ?? match
  })
}

function plain(markup: string): string {
  return decodeEntities(markup.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

export function excerpt(post: { summary: string | null; html: string }, max = 280): string {
  let text = plain(post.summary ?? '')
  if (text === '') text = plain(post.html)
  if (text.length <= max) return text
  const space = text.lastIndexOf(' ', max)
  return text.slice(0, space > 0 ? space : max).trimEnd() + '…'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

function siteUrl(config: Config, siteId: string, action: string, token: string): string {
  return `${config.publicUrl.origin}/sites/${siteId}/${action}?token=${encodeURIComponent(token)}`
}

export function confirmUrl(config: Config, siteId: string, token: string): string {
  return siteUrl(config, siteId, 'confirm', token)
}

export function unsubscribeUrl(config: Config, siteId: string, token: string): string {
  return siteUrl(config, siteId, 'unsubscribe', token)
}

function layout(title: string, inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${FONT_FACES}</style>
</head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:672px;">
<tr><td style="${BODY}">
${inner}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`
}

function siteHeading(site: SiteConfig): string {
  return `<p style="${SITE_NAME}">${escapeHtml(site.name)}</p>`
}

function footer(inner: string): string {
  return `<div style="${FOOTER}">${inner}</div>`
}

export function newPostEmail(site: SiteConfig, post: PostRow, unsubscribe: string): RenderedEmail {
  const summary = excerpt(post)
  const date = formatDate(post.published)
  const html = layout(
    post.title,
    `${siteHeading(site)}
<h1 style="${TITLE}">${escapeHtml(post.title)}</h1>
<p style="font-family:${MONO};font-size:12.5px;color:#8a857b;margin:0 0 28px;">${escapeHtml(date)}</p>
<p style="margin:0 0 24px;">${escapeHtml(summary)}</p>
<p style="margin:0;"><a href="${escapeHtml(post.url)}" style="${LINK}">Keep reading →</a></p>
${footer(`You're getting this because you subscribed at ${escapeHtml(site.domain)}. <a href="${escapeHtml(unsubscribe)}" style="${LINK}">Unsubscribe</a>`)}`,
  )
  const text = [
    site.name,
    '',
    post.title,
    date,
    '',
    summary,
    '',
    `Keep reading: ${post.url}`,
    '',
    `You're getting this because you subscribed at ${site.domain}. Unsubscribe: ${unsubscribe}`,
    '',
  ].join('\n')
  return { subject: post.title, html, text }
}

export function confirmationEmail(site: SiteConfig, confirm: string): RenderedEmail {
  const subject = `Confirm your subscription to ${site.name}`
  const ask = `Someone (hopefully you) asked to get new posts from ${site.name} by email.`
  const ignore = "If this wasn't you, ignore this email and nothing happens. The link expires in 48 hours."
  const html = layout(
    subject,
    `${siteHeading(site)}
<h1 style="${TITLE}">One click and you're in</h1>
<p style="margin:20px 0 28px;">${escapeHtml(ask)}</p>
<p style="margin:0;"><a href="${escapeHtml(confirm)}" style="${BUTTON}">Confirm my subscription</a></p>
${footer(escapeHtml(ignore))}`,
  )
  const text = [site.name, '', "One click and you're in", '', ask, '', `Confirm my subscription: ${confirm}`, '', ignore, ''].join(
    '\n',
  )
  return { subject, html, text }
}

export function expiredLinkPage(site: SiteConfig): string {
  return layout(
    site.name,
    `${siteHeading(site)}
<h1 style="${TITLE}">This link has expired or was already used.</h1>
<p style="margin:20px 0 0;"><a href="${escapeHtml(`https://${site.domain}/`)}" style="${LINK}">Back to ${escapeHtml(site.name)}</a></p>`,
  )
}

export function unsubscribePage(site: SiteConfig, action: string): string {
  const title = `Unsubscribe from ${site.name}?`
  return layout(
    title,
    `${siteHeading(site)}
<h1 style="${TITLE}">${escapeHtml(title)}</h1>
<div style="margin:28px 0 0;">
<form method="post" action="${escapeHtml(action)}">
<button type="submit" style="${BUTTON};cursor:pointer;">Unsubscribe</button>
</form>
</div>`,
  )
}
