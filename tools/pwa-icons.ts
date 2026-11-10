// ホーム画面のアイコン (public/pwa/*.png) を作る。TORO Server のロゴ (TORO-Website の logo.svg) の 2 行目を地図の名前にしたもの
// node tools/pwa-icons.ts   (絵を変えたときだけ動かし、できた png をコミットする)
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'

const apps = [
  { id: 'map', sub: 'Map', subSize: 72 },
  { id: '3d-map', sub: '3D Map', subSize: 64 },
]

/** 左が黒地に白、右が白地に黒のロゴ。scale はマスク可能なアイコン (丸や角丸に切られる) のために文字を内側へ寄せる率 */
function logo(sub: string, subSize: number, scale: number): string {
  const t = (1 - scale) * 256
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <g id="t" transform="translate(${t} ${t}) scale(${scale})">
      <text x="50%" y="45%" font-family="'Times New Roman', Times, serif" font-weight="bold" font-size="160" text-anchor="middle" dominant-baseline="middle">TORO</text>
      <text x="50%" y="72%" font-family="'Times New Roman', Times, serif" font-size="${subSize}" text-anchor="middle" dominant-baseline="middle" letter-spacing="2">${sub}</text>
    </g>
    <clipPath id="l"><rect x="0" y="0" width="256" height="512"/></clipPath>
    <clipPath id="r"><rect x="256" y="0" width="256" height="512"/></clipPath>
  </defs>
  <g clip-path="url(#l)"><rect width="512" height="512" fill="black"/><use href="#t" fill="white"/></g>
  <g clip-path="url(#r)"><rect width="512" height="512" fill="white"/><use href="#t" fill="black"/></g>
</svg>`
}

await mkdir('public/pwa', { recursive: true })
for (const app of apps) {
  const plain = Buffer.from(logo(app.sub, app.subSize, 1))
  const maskable = Buffer.from(logo(app.sub, app.subSize, 0.72))
  await sharp(plain).resize(192).png().toFile(`public/pwa/${app.id}-192.png`)
  await sharp(plain).resize(512).png().toFile(`public/pwa/${app.id}-512.png`)
  await sharp(maskable).resize(512).png().toFile(`public/pwa/${app.id}-maskable-512.png`)
  // iOS は角を丸めるだけなので、文字が端に寄りすぎないよう少し内側へ
  await sharp(Buffer.from(logo(app.sub, app.subSize, 0.9))).resize(180).png().toFile(`public/pwa/${app.id}-apple-180.png`)
}
console.log('public/pwa/*.png')
