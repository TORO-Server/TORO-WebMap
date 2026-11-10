import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { H3Event } from 'h3'

export interface Body {
  data: Buffer | string
  type: string
  cache: string
  etag?: string
  lastModified?: Date
  encoding?: string
}

/** 本文を返す。If-None-Match が ETag と同じなら 304 */
export function respond(event: H3Event, body: Body): Buffer | string {
  const etag = body.etag ?? `"${createHash('md5').update(body.data).digest('hex')}"`
  setResponseHeaders(event, {
    'Content-Type': body.type,
    'Cache-Control': body.cache,
    'ETag': etag,
    'Access-Control-Allow-Origin': '*',
  })
  if (body.lastModified) setResponseHeader(event, 'Last-Modified', body.lastModified.toUTCString())
  if (body.encoding) {
    setResponseHeader(event, 'Content-Encoding', body.encoding)
    setResponseHeader(event, 'Vary', 'Accept-Encoding')
  }
  if (getRequestHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return ''
  }
  return body.data
}

let blank: Buffer | undefined

/** Dynmap の web/images/blank.png (描いていないタイルの代わり) */
export async function dynmapBlank(event: H3Event): Promise<Buffer | string> {
  blank ??= await readFile(join(useRuntimeConfig().dynmap.web, 'images', 'blank.png'))
  return respond(event, { data: blank, type: 'image/png', cache: 'public, max-age=60' })
}
