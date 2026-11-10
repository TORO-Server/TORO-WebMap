import test from 'node:test'
import assert from 'node:assert/strict'

// markers.ts の zoomOrNone と同じロジック
const zoomOrNone = (z: number | undefined | null): number => (typeof z === 'number' && z > 0 ? z : -1)

test('zoomOrNone: 0 や負数や未定義は -1 (制限なし) として正規化される', () => {
  assert.equal(zoomOrNone(undefined), -1)
  assert.equal(zoomOrNone(null), -1)
  assert.equal(zoomOrNone(0), -1)
  assert.equal(zoomOrNone(-1), -1)
  assert.equal(zoomOrNone(-5), -1)
  assert.equal(zoomOrNone(1), 1)
  assert.equal(zoomOrNone(2), 2)
  assert.equal(zoomOrNone(5), 5)
})

test('マーカーのズーム表示判定ロジック: minzoom / maxzoom の正規化と範囲判定', () => {
  const isShown = (
    markerMin: number | undefined,
    markerMax: number | undefined,
    setMin: number | undefined,
    setMax: number | undefined,
    currentZoom: number
  ): boolean => {
    const itemMin = zoomOrNone(markerMin)
    const itemMax = zoomOrNone(markerMax)
    const setMinNorm = zoomOrNone(setMin)
    const setMaxNorm = zoomOrNone(setMax)
    const minzoom = itemMin >= 0 ? itemMin : setMinNorm
    let maxzoom = itemMax >= 0 ? itemMax : setMaxNorm
    if (maxzoom < 0) maxzoom = 100
    return (minzoom < 0 || currentZoom >= minzoom) && (maxzoom < 0 || currentZoom <= maxzoom)
  }

  // 1. 制限なし (0 や undefined) の場合、どのズームでも表示されること
  assert.equal(isShown(undefined, undefined, undefined, undefined, 0), true)
  assert.equal(isShown(undefined, undefined, undefined, undefined, 1), true)
  assert.equal(isShown(undefined, undefined, undefined, undefined, 5), true)
  assert.equal(isShown(0, 0, 0, 0, 0), true)
  assert.equal(isShown(0, 0, 0, 0, 1), true)
  assert.equal(isShown(0, 0, 0, 0, 5), true)

  // 2. マーカーセットで minzoom = 2, maxzoom = 4 が指定された場合
  assert.equal(isShown(undefined, undefined, 2, 4, 1), false)
  assert.equal(isShown(undefined, undefined, 2, 4, 2), true)
  assert.equal(isShown(undefined, undefined, 2, 4, 3), true)
  assert.equal(isShown(undefined, undefined, 2, 4, 4), true)
  assert.equal(isShown(undefined, undefined, 2, 4, 5), false)

  // 3. マーカー個別で minzoom = 3 が指定され、セット指定を上書きする場合
  assert.equal(isShown(3, undefined, 2, 4, 2), false)
  assert.equal(isShown(3, undefined, 2, 4, 3), true)
  assert.equal(isShown(3, undefined, 2, 4, 4), true)
})
