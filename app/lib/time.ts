// Minecraft の時刻 (web/js/minecraft.js の getMinecraftTime と同じ)

export interface MinecraftTime {
  servertime: number
  hours: number
  minutes: number
  day: boolean
}

export function minecraftTime(servertime: number): MinecraftTime {
  const t = Math.trunc(servertime)
  // 6:00 を昼の始まりとする
  return {
    servertime: t,
    hours: (Math.trunc(t / 1000) + 6) % 24,
    minutes: Math.trunc(((t / 1000) % 1) * 60),
    day: t >= 0 && t < 13700,
  }
}

/** 地図の背景や天気の昼・夜 (web/js/map.js の serverday と同じ境目) */
export function isServerDay(servertime: number): boolean {
  return servertime > 23100 || servertime < 12900
}

/** 太陽と月の絵の位置 (web/js/timeofdayclock.js と同じ計算)。夜は太陽の角度に π を足して月にする */
export function sunAngle(time: number): number {
  if (isServerDay(time)) {
    let moved = time + 900
    if (moved >= 24000) moved -= 24000
    // 昼の 0..13800 を 27600 で割り、昼を縮める
    return (moved / 27600) * 2 * Math.PI
  }
  // 夜の 0..10200 を 20400 で割り、夜を伸ばす
  return Math.PI + ((time - 12900) / 20400) * 2 * Math.PI
}
