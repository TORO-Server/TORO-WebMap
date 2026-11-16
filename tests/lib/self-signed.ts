// 試験だけの使い捨ての自己署名の証明書と鍵を、試験の実行時に作る (リポジトリには鍵も証明書も置かない)。
// 試験の HTTPS のサーバーは、決まった名前だけを手元につなぎ、証明書を確かめないので、中身は最小の X.509 v3 で足りる。
// 依存を足さず node:crypto だけで作る (openssl の実行ファイルは Dockerfile の test 段 (node:alpine) に無い)
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'

const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts)
  const n = body.length
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]
  return Buffer.concat([Buffer.from([tag, ...len]), body])
}
const oid = (...bytes: number[]): Buffer => der(0x06, Buffer.from(bytes))
const SHA256_RSA = der(0x30, oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b), der(0x05))
const utcTime = (d: Date): Buffer => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))
const pem = (label: string, data: Buffer): string =>
  `-----BEGIN ${label}-----\n${data.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END ${label}-----\n`

export function selfSignedPair(commonName = 'toro-webmap.test'): { cert: string, key: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const name = der(0x30, der(0x31, der(0x30, oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from(commonName)))))
  const serial = randomBytes(8)
  serial[0] = serial[0]! & 0x7f || 1 // 正の整数にする
  const now = Date.now()
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    SHA256_RSA,
    name,
    der(0x30, utcTime(new Date(now - 3600_000)), utcTime(new Date(now + 2 * 86400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }) as Buffer,
  )
  const signature = sign('sha256', tbs, privateKey)
  const cert = der(0x30, tbs, SHA256_RSA, der(0x03, Buffer.from([0]), signature))
  return { cert: pem('CERTIFICATE', cert), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }
}
