// 起動したら、構造物の看板のための Minecraft のリソースのまとめ (/mcassets/) を作り始める (最初に読む人を待たせないように)
export default defineNitroPlugin(() => {
  if (!useRuntimeConfig().mcassets.jar) return
  setTimeout(() => void mcAssets(), 1000)
})
