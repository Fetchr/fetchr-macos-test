import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(dir, p), 'utf8')

const inlineAssets = (text) =>
  text.replace(/\b((?:covers|current|icons|fonts)\/[\w./-]+\.(?:png|svg|ttf))\b/g, (path) => {
    const file = join(dir, path)
    if (!existsSync(file)) return path
    const mime = path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.ttf') ? 'font/ttf' : 'image/png'
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`
  })

const html = read('index.html')
  .replace('<link rel="stylesheet" href="mock.css">', () => `<style>${read('mock.css')}</style>`)
  .replace(/<script src="([\w.-]+\.js)"><\/script>/g, (_, src) => `<script>${read(src).replace(/<\/script/gi, '<\\/script')}</script>`)

writeFileSync(join(dir, 'mock.html'), inlineAssets(html))
