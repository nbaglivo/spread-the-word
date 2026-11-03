import { createServer, type IncomingMessage } from 'node:http'
import type { Config } from '../src/config.ts'

export type Delivery = { path: string; type: string; body: Record<string, unknown> }

export type FakeRemote = {
  origin: string
  actorId: string
  inbox: string
  sharedInbox: string
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
      email: undefined,
    },
  ],
  smtp: undefined,
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf-8')
}

export async function startFakeRemote(): Promise<FakeRemote> {
  const deliveries: Delivery[] = []
  let origin = ''
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/users/alice') {
      res.writeHead(200, { 'content-type': 'application/activity+json' })
      res.end(
        JSON.stringify({
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${origin}/users/alice`,
          type: 'Person',
          preferredUsername: 'alice',
          inbox: `${origin}/users/alice/inbox`,
          endpoints: { sharedInbox: `${origin}/inbox` },
        }),
      )
      return
    }
    if (req.method === 'POST' && req.url?.startsWith('/gone/')) {
      res.writeHead(410)
      res.end()
      return
    }
    if (req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      deliveries.push({ path: req.url ?? '', type: String(body.type), body })
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
  return {
    origin,
    actorId: `${origin}/users/alice`,
    inbox: `${origin}/users/alice/inbox`,
    sharedInbox: `${origin}/inbox`,
    deliveries,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
