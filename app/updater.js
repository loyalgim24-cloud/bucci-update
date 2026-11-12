/**
 * 부찌 자동 업데이트 (바뀐 파일만 받는 방식)
 * ─────────────────────────────────────────────────────────
 * 1) 켜질 때 업데이트 전용 GitHub 저장소(bucci-update)의 version.json 을 읽어 내 버전(설치 폴더의 version.json)과 비교
 * 2) 새 버전이면 사용자에게 묻고, update_manifest.json 의 파일 목록 중 내 파일과 다른 것만 내려받음
 * 3) 전부 받아서 검증(sha256)이 끝난 뒤에만 교체. 중간에 실패하면 원래 파일로 되돌림
 * 4) 다시 시작
 *
 * 인터넷이 안 되거나(행망 등) 확인에 실패하면 아무 것도 하지 않고 조용히 넘어갑니다.
 * 개발 폴더(bucci_setup.iss, .git, .noupdate 가 있는 폴더)에서는 동작하지 않습니다 —
 * 작업 중인 파일을 저장소 버전으로 덮어쓰지 않기 위함입니다.
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const http = require('http')
const https = require('https')

const BASE = process.env.BUCCI_UPDATE_URL || 'https://raw.githubusercontent.com/loyalgim24-cloud/bucci-update/main/'
const ROOT = path.join(__dirname, '..')

function isDevFolder(root) {
  return ['bucci_setup.iss', '.git', '.noupdate'].some(f => fs.existsSync(path.join(root, f)))
}

function get(url, timeoutMs, redirects) {
  redirects = redirects || 0
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.get(url, { headers: { 'User-Agent': 'bucci-updater', 'Cache-Control': 'no-cache' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume()
        return get(new URL(res.headers.location, url).href, timeoutMs, redirects + 1).then(resolve, reject)
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs || 8000, () => req.destroy(new Error('timeout')))
  })
}

// 'a/b 한글.png' → URL 경로 (조각마다 인코딩)
function urlFor(base, rel) {
  return base.replace(/\/?$/, '/') + rel.split('/').map(encodeURIComponent).join('/')
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex') }
function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0 ? 1 : -1
  }
  return 0
}
function localVersion(root) {
  try { return String(JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8')).version || '0.0.0') }
  catch { return '0.0.0' }
}
// 목록의 경로가 설치 폴더의 app/ 아래만 가리키는지 확인 (그 밖의 위치에는 절대 쓰지 않음)
function safeDest(root, rel) {
  if (typeof rel !== 'string' || !rel.startsWith('app/') || rel.includes('\\') || rel.includes('\0')) return null
  if (rel.split('/').some(seg => !seg || seg === '.' || seg === '..')) return null
  const dest = path.join(root, ...rel.split('/'))
  const appDir = path.join(root, 'app') + path.sep
  return dest.startsWith(appDir) ? dest : null
}

// 새 버전이 있는지 확인
async function check(root, base) {
  root = root || ROOT; base = base || BASE
  const local = localVersion(root)
  const remote = JSON.parse((await get(urlFor(base, 'version.json'), 6000)).toString('utf8'))
  if (!remote || typeof remote.version !== 'string') throw new Error('bad version.json')
  return { available: cmpVer(remote.version, local) > 0, local, remote }
}

// 바뀐 파일을 받아서 교체. 반환: { updated: 교체한 파일 수 }
async function apply(root, base, remote, onProgress) {
  root = root || ROOT; base = base || BASE
  const manifest = JSON.parse((await get(urlFor(base, 'update_manifest.json'), 20000)).toString('utf8'))
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('bad manifest')
  if (manifest.version !== remote.version) throw new Error('manifest/version mismatch')   // 올리는 도중이면 다음에 다시

  // 1) 내 파일과 다른 것만 추림
  const todo = []
  for (const f of manifest.files) {
    const dest = safeDest(root, f.p)
    if (!dest || typeof f.h !== 'string') throw new Error('unsafe path in manifest: ' + f.p)
    let same = false
    try { same = sha256(fs.readFileSync(dest)) === f.h } catch {}
    if (!same) todo.push({ rel: f.p, dest, hash: f.h })
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bucci_update_'))
  const tmpDir = path.join(work, 'new'), bakDir = path.join(work, 'old')
  const cleanup = () => { try { fs.rmSync(work, { recursive: true, force: true }) } catch {} }
  try {
    // 2) 전부 임시 폴더에 받아서 검증 (여기까지는 설치 폴더를 건드리지 않음)
    let done = 0
    const queue = todo.slice()
    const worker = async () => {
      while (queue.length) {
        const t = queue.shift()
        const buf = await get(urlFor(base, t.rel), 60000)
        if (sha256(buf) !== t.hash) throw new Error('hash mismatch: ' + t.rel)
        t.tmp = path.join(tmpDir, ...t.rel.split('/'))
        fs.mkdirSync(path.dirname(t.tmp), { recursive: true })
        fs.writeFileSync(t.tmp, buf)
        done++
        if (onProgress) { try { onProgress(done, todo.length) } catch {} }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])

    // 3) 교체. 하나라도 실패하면 전부 원래대로
    const swapped = []
    try {
      for (const t of todo) {
        const existed = fs.existsSync(t.dest)
        if (existed) {
          const bak = path.join(bakDir, ...t.rel.split('/'))
          fs.mkdirSync(path.dirname(bak), { recursive: true })
          fs.copyFileSync(t.dest, bak)
          t.bak = bak
        }
        swapped.push({ t, existed })
        fs.mkdirSync(path.dirname(t.dest), { recursive: true })
        fs.copyFileSync(t.tmp, t.dest)
      }
      fs.writeFileSync(path.join(root, 'version.json'), JSON.stringify({ version: remote.version, notes: remote.notes || '', date: remote.date || '' }, null, 2))
    } catch (e) {
      swapped.reverse().forEach(({ t, existed }) => {
        try { if (existed) fs.copyFileSync(t.bak, t.dest); else fs.rmSync(t.dest, { force: true }) } catch {}
      })
      throw e
    }
    return { updated: todo.length }
  } finally { cleanup() }
}

// 새 버전을 알리고, 사용자가 고르면 받아서 적용한 뒤 다시 시작.
// 안내는 부찌 화면 안의 창으로 띄움 (index.html 의 __bucciUpdatePrompt / Progress / Done).
// 화면이 아직 준비되지 않았거나 그 함수가 없으면 Windows 기본 창으로 대신함.
function ui(win, fn, arg) {
  return win.webContents.executeJavaScript(`window.${fn}(${JSON.stringify(arg === undefined ? null : arg)})`, true)
}
async function hasInAppUi(win) {
  try {
    const ok = await Promise.race([
      win.webContents.executeJavaScript('typeof window.__bucciUpdatePrompt === "function" && typeof window.__bucciUpdateDone === "function"', true),
      new Promise(r => setTimeout(() => r(false), 3000))
    ])
    return ok === true
  } catch { return false }
}
async function promptAndApply(ctx, c) {
  const win = ctx.getWindow()
  if (!win || win.isDestroyed()) return 'no-window'
  if (!(await hasInAppUi(win))) return promptAndApplyNative(ctx, c)
  let ans
  try { ans = await ui(win, '__bucciUpdatePrompt', { local: c.local, version: c.remote.version, notes: c.remote.notes || '' }) }
  catch { return promptAndApplyNative(ctx, c) }
  if (ans !== 'now') return 'later'
  const progress = (d, t) => {
    try {
      if (win.isDestroyed()) return
      win.setProgressBar(t ? d / t : 1)
      win.webContents.executeJavaScript(`window.__bucciUpdateProgress && window.__bucciUpdateProgress(${d},${t})`, true).catch(() => {})
    } catch {}
  }
  try {
    const r = await apply(ROOT, BASE, c.remote, progress)
    try { win.setProgressBar(-1) } catch {}
    try { await ui(win, '__bucciUpdateDone', { ok: true, version: c.remote.version, updated: r.updated }) } catch {}
    ctx.app.relaunch()
    ctx.app.exit(0)
    return 'updated'
  } catch (e) {
    try { win.setProgressBar(-1) } catch {}
    try { await ui(win, '__bucciUpdateDone', { ok: false, error: String(e && e.message ? e.message : e) }) } catch {}
    return 'failed'
  }
}

// (대비용) 화면 안의 창을 쓸 수 없을 때는 Windows 기본 창으로 안내
async function promptAndApplyNative(ctx, c) {
  const win = ctx.getWindow()
  if (!win || win.isDestroyed()) return 'no-window'
  const ask = await ctx.dialog.showMessageBox(win, {
    type: 'info', title: '부찌 업데이트', buttons: ['지금 업데이트', '나중에'], defaultId: 0, cancelId: 1, noLink: true,
    message: `새 버전 ${c.remote.version} 이 있습니다. (현재 ${c.local})`,
    detail: (c.remote.notes ? c.remote.notes + '\n\n' : '') + '바뀐 파일만 받아서 적용한 뒤 부찌를 다시 시작합니다.'
  })
  if (ask.response !== 0) return 'later'
  try {
    const r = await apply(ROOT, BASE, c.remote, (d, t) => { try { if (!win.isDestroyed()) { win.setProgressBar(t ? d / t : 1); win.setTitle(`부찌 — 업데이트 받는 중 ${d}/${t}`) } } catch {} })
    try { win.setProgressBar(-1) } catch {}
    await ctx.dialog.showMessageBox(win, { type: 'info', title: '부찌 업데이트', buttons: ['다시 시작'], message: `버전 ${c.remote.version} 으로 업데이트했습니다.`, detail: `파일 ${r.updated}개를 교체했습니다. 부찌를 다시 시작합니다.` })
    ctx.app.relaunch()
    ctx.app.exit(0)
    return 'updated'
  } catch (e) {
    try { win.setProgressBar(-1) } catch {}
    await ctx.dialog.showMessageBox(win, { type: 'warning', title: '부찌 업데이트', buttons: ['확인'], message: '업데이트를 적용하지 못했습니다.', detail: '기존 버전 그대로 계속 사용할 수 있습니다. 다음에 켤 때 다시 시도합니다.\n\n(' + (e && e.message ? e.message : e) + ')' })
    return 'failed'
  }
}

// 켜질 때 자동 확인: 새 버전이 없거나 인터넷이 안 되면 아무 표시 없이 넘어감
async function start(ctx) {
  try {
    if (isDevFolder(ROOT)) return
    const c = await check()
    if (c.available) await promptAndApply(ctx, c)
  } catch { /* 인터넷 없음 등 */ }
}

// 화면의 "업데이트 확인"을 눌렀을 때: 결과를 항상 알려줌
// 반환 status: latest(최신) | later(나중에) | updated | failed | offline(확인 실패) | dev(작업 폴더)
async function manual(ctx) {
  const local = localVersion(ROOT)
  if (isDevFolder(ROOT)) return { status: 'dev', version: local }
  let c
  try { c = await check() } catch (e) { return { status: 'offline', version: local, error: String(e && e.message || e) } }
  if (!c.available) return { status: 'latest', version: local }
  const status = await promptAndApply(ctx, c)
  return { status, version: local, latest: c.remote.version }
}

// 업데이트 내역 (app/changelog.json — 올릴 때마다 한 줄씩 쌓이고 업데이트로 함께 배포됨)
function history() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'changelog.json'), 'utf8'))
    return Array.isArray(list) ? list.filter(e => e && e.version).slice(0, 50) : []
  } catch { return [] }
}
function info() { return { version: localVersion(ROOT), dev: isDevFolder(ROOT), history: history() } }

module.exports = { start, manual, info, check, apply, cmpVer, safeDest, isDevFolder }
