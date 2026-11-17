/**
 * 부찌 — 디자이너스(ko.designus.design) 레퍼런스 수집
 * ─────────────────────────────────────────────────────────
 * 디자이너스의 앱 페이지를 사람이 보듯 브라우저로 열어서, 화면에 보이는 앱 화면 이미지 주소와
 * 패턴·컴포넌트 분류를 모아 designus_refs.json 으로 저장합니다.
 * 부찌는 켜질 때 이 파일을 저장소에서 받아 검색 결과에 함께 보여줍니다.
 *
 * GitHub 가 매달 자동으로 실행합니다 (.github/workflows/designus.yml).
 * 직접 시험해 보려면 (Microsoft Edge 사용):
 *   npm install playwright-core
 *   node designus_collect.js --limit 3           앱 3개만 시범으로
 *   node designus_collect.js                     전체
 *
 * 옵션
 *   --limit N     앱 N개만 모음 (시범용)
 *   --no-tags     패턴·컴포넌트 분류는 건너뜀 (빠름)
 *   --retag       이미 분류한 앱도 다시 분류
 *   --out 파일    저장할 곳 (기본: 이 파일 옆 designus_refs.json)
 *
 * 지키는 것
 *   - robots.txt 가 허용한 공개 페이지만 엽니다. 로그인하지 않습니다.
 *   - 사이트 내부 키나 내부 서버 주소를 직접 쓰지 않고, 페이지가 원래 동작하는 대로만 엽니다.
 *   - 페이지·동작 사이마다 쉬어 가며 천천히 엽니다.
 *   - 이미지는 내려받지 않고 주소만 저장합니다 (부찌가 볼 때 디자이너스에서 불러옴).
 *   - 수집 결과가 지난번보다 크게 줄면(사이트 구조가 바뀐 것으로 보고) 저장하지 않고 실패로 끝냅니다.
 */
const fs = require('fs')
const path = require('path')

let pw
try { pw = require('playwright-core') } catch { try { pw = require('playwright') } catch {
  console.log('\n[준비 필요] npm install playwright-core 를 먼저 실행해주세요.\n'); process.exit(1)
} }

const SITE = process.env.DESIGNUS_SITE || 'https://ko.designus.design'
const SITEMAP = process.env.DESIGNUS_SITEMAP || 'https://api.designus.design/api/web/sitemap.xml'   // robots.txt 에 적힌 공개 사이트맵
const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def }
const LIMIT = Number(opt('--limit', 0)) || 0
const NO_TAGS = !!opt('--no-tags', false)
const RETAG = !!opt('--retag', false)
const OUT = path.resolve(String(opt('--out', path.join(__dirname, 'designus_refs.json'))))
const PAUSE = Number(process.env.DESIGNUS_PAUSE || 700)    // 동작 사이 쉬는 시간(ms)
const wait = ms => new Promise(r => setTimeout(r, ms))

// 디자이너스 분류 → 부찌 태그 (부찌에 이미 있는 이름으로 맞춤). 여기 있는 분류만 모읍니다.
const PATTERN_MAP = {
  '스플래시': ['스플래시'], '시작화면과 버튼 조합': ['온보딩'], '온보딩': ['온보딩'], '가입': ['회원가입'], '로그인': ['로그인'],
  '인증': ['인증'], '프로필 정보 설정': ['프로필', '설정'], '튜토리얼': ['튜토리얼'], '홈': ['홈화면'], '피드': ['피드'],
  '목록': ['목록'], '채팅': ['채팅'], '메시지': ['메시지'], '지도': ['지도'], '일정': ['일정', '캘린더'], '검색': ['검색', '검색결과'],
  '송금/이체': ['송금', '이체'], '결제': ['결제'], '장바구니': ['장바구니'], '구매내역 및 이용내역': ['주문내역', '이용내역'],
  '알림': ['알림'], '푸시 알림': ['푸시', '알림'], '프로필': ['프로필', '마이페이지'], '리뷰': ['리뷰'], '필터': ['필터'],
  '권한': ['권한'], '오류/에러': ['에러', '오류'], '이벤트': ['이벤트'], '프로모션': ['프로모션'], '이용약관': ['약관'],
  '개인정보보호방침': ['약관'], '고객지원 및 문의하기': ['고객센터'], '안내문': ['안내'],
}
const COMPONENT_MAP = {
  '바텀 시트': ['바텀시트'], '모달/다이얼로그': ['모달', '다이얼로그', '팝업'], '스낵바 & 토스트': ['토스트', '스낵바'], '탭 바': ['탭바'],
  '탭': ['탭'], '카드': ['카드'], '리스트': ['리스트'], '캐로셀': ['캐러셀'], '배너': ['배너'], '텍스트 필드': ['텍스트필드', '입력폼'],
  '검색 바': ['검색바'], '칩': ['칩'], '토글 스위치': ['토글'], '체크박스': ['체크박스'], '프로그레스 인디케이터': ['프로그레스'],
  '스켈레톤': ['스켈레톤'], '아코디언': ['아코디언'], '플로팅 버튼': ['플로팅버튼'], '날짜 선택기/날짜 피커': ['날짜선택', '캘린더'],
  '일러스트레이션': ['일러스트'],
}

// ── 앱 목록: 공개 사이트맵에서 /reference/service/번호 를 모음 ──
async function appIds(page) {
  const res = await page.goto(SITEMAP, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const text = await res.text()
  const ids = [...new Set([...text.matchAll(/\/reference\/service\/(\d+)/g)].map(m => m[1]))]
  if (!ids.length) throw new Error('사이트맵에서 앱 목록을 찾지 못했어요')
  return ids
}

// 페이지 안에서 실제로 스크롤되는 영역을 끝까지 천천히 내려서 화면을 모두 불러옴
async function loadAllScreens(page) {
  return page.evaluate(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const pick = () => [...document.querySelectorAll('*')].filter(e => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 50)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.scrollingElement
    const count = () => document.querySelectorAll('.screens .reference-screen img').length
    let stall = 0, lastC = -1, lastH = -1
    for (let k = 0; k < 300 && stall < 4; k++) {
      const sc = pick()
      sc.scrollTop = sc.scrollTop + sc.clientHeight * 0.8
      window.scrollBy(0, innerHeight * 0.8)
      await wait(400)
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 5) await wait(900)
      const c = count(), h = sc.scrollHeight
      if (c === lastC && h === lastH) stall++; else stall = 0
      lastC = c; lastH = h
    }
    const sc = pick(); sc.scrollTop = 0; window.scrollTo(0, 0)
  })
}
async function visibleScreens(page) {
  return page.evaluate(() => [...document.querySelectorAll('.screens .reference-screen img')]
    .map(i => i.currentSrc || i.src).filter(u => u.includes('/app-screen/')))
}

// ── 패턴·컴포넌트로 걸러서, 어떤 화면에 어떤 분류가 붙는지 알아냄 ──
// 페이지의 "컴포넌트"/"패턴" 버튼을 눌러 목록을 열고, 분류를 하나씩 골라 남는 화면을 기록한 뒤 "초기화"로 되돌림
async function clickVisibleText(page, text) {
  const loc = page.getByText(text, { exact: true })
  const n = await loc.count().catch(() => 0)
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i)
    if (await el.isVisible().catch(() => false)) { await el.click({ timeout: 3000 }).catch(() => {}); await wait(PAUSE); return true }
  }
  return false
}
// 지금 열려 있는 목록에서 "이름 (숫자)" 형태인 분류 이름들 (사이트 전체에 0개인 분류는 숫자가 없어서 빠짐)
async function listedLabels(page) {
  return page.evaluate(() => [...document.querySelectorAll('li')].filter(li => li.offsetParent)
    .map(li => li.textContent.replace(/\s+/g, ' ').trim().match(/^(.+?)\s*\((\d+)\)$/)).filter(Boolean).map(m => m[1].trim()))
}
function labelItem(page, label) {
  const re = new RegExp('^\\s*' + label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\\s*\\(\\d+\\)\\s*$')
  return page.locator('li').filter({ hasText: re }).first()
}
async function resetFilter(page) {
  const btn = page.getByText('초기화', { exact: true }).first()
  if (await btn.isVisible().catch(() => false)) { await btn.click({ timeout: 3000 }).catch(() => {}); await wait(PAUSE) }
}
async function tagScreens(page, srcs) {
  const tags = Object.fromEntries(srcs.map(s => [s, new Set()]))
  for (const [category, map] of [['패턴', PATTERN_MAP], ['컴포넌트', COMPONENT_MAP]]) {
    await resetFilter(page)
    await clickVisibleText(page, category)
    const listed = new Set(await listedLabels(page))
    const todo = Object.keys(map).filter(l => listed.has(l))
    for (const label of todo) {
      try {
        let item = labelItem(page, label)
        if (!(await item.isVisible().catch(() => false))) { await resetFilter(page); await clickVisibleText(page, category); item = labelItem(page, label) }
        if (!(await item.isVisible().catch(() => false))) continue
        await item.click({ timeout: 4000 })
        await wait(PAUSE * 2)
        try { await page.waitForLoadState('networkidle', { timeout: 6000 }) } catch {}
        await loadAllScreens(page)
        const hits = await visibleScreens(page)
        hits.forEach(h => { if (tags[h]) map[label].forEach(t => tags[h].add(t)) })
        await resetFilter(page)
      } catch (e) { /* 이 분류만 건너뜀 */ }
    }
  }
  await resetFilter(page)
  return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, [...v]]))
}

// ── 색상·다크/라이트 (부찌의 다른 자료와 같은 기준), 섹션 표지 이미지 판별 ──
async function analyze(tool, jpg) {
  return tool.evaluate(async b64 => {
    const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode()
    const c = document.createElement('canvas'); c.width = 32; c.height = 32
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 32, 32)
    const d = g.getImageData(0, 0, 32, 32).data
    let lum = 0, sat = 0; const hues = {}; const ls = []
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255
      const L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; lum += L; ls.push(L)
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), s = mx === 0 ? 0 : (mx - mn) / mx
      if (s > 0.2 && mx > 0.15) {
        sat++
        let h = mx === r ? ((gg - b) / (mx - mn)) % 6 : mx === gg ? (b - r) / (mx - mn) + 2 : (r - gg) / (mx - mn) + 4
        h = (h * 60 + 360) % 360
        const tone = h < 15 || h >= 330 ? '레드톤' : h < 40 ? '오렌지톤' : h < 70 ? '옐로우톤' : h < 170 ? '그린톤' : h < 255 ? '블루톤' : '퍼플톤'
        hues[tone] = (hues[tone] || 0) + 1
      }
    }
    const n = d.length / 4, avg = lum / n
    ls.sort((a, b) => a - b); const med = ls[n >> 1]
    const flat = ls.filter(v => Math.abs(v - med) < 14).length / n
    const cover = flat > 0.86 && avg < 70                      // 거의 한 가지 어두운 색 + 글자 몇 개 = 섹션 표지
    const tags = []
    if (avg < 80) tags.push('다크모드'); else if (avg > 175) tags.push('라이트모드')
    tags.push(sat / n > 0.04 ? Object.entries(hues).sort((a, b) => b[1] - a[1])[0][0] : '모노톤')
    return { tags, cover }
  }, jpg.toString('base64'))
}

// ── 앱 하나 ──
async function collectApp(page, tool, id, prev) {
  await page.goto(`${SITE}/reference/service/${id}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  try { await page.waitForLoadState('networkidle', { timeout: 10000 }) } catch {}
  await page.waitForFunction(() => /\(.+\)/.test(document.title), null, { timeout: 10000 }).catch(() => {})
  await wait(PAUSE)
  const meta = await page.evaluate(() => {
    const m = document.title.match(/\((.+?)\)/)
    const logo = [...document.images].map(i => i.currentSrc || i.src).find(u => u.includes('/app-logo/')) || ''
    const lines = (document.querySelector('main') || document.body).innerText.split('\n').map(s => s.trim()).filter(Boolean)
    const name = m ? m[1].trim() : ''
    const i = lines.lastIndexOf(name)
    return { name, logo, desc: i >= 0 && lines[i + 1] && !lines[i + 1].startsWith('©') ? lines[i + 1] : '' }
  })
  if (!meta.name) throw new Error('앱 이름을 찾지 못했어요')
  await loadAllScreens(page)
  const srcs = [...new Set(await visibleScreens(page))]
  if (!srcs.length) throw new Error('화면을 찾지 못했어요')

  // 색상 분석·표지 판별: 화면 카드를 찍어서 분석 (이미 분석한 화면은 그대로 씀)
  const prevScreens = new Map((prev ? prev.screens : []).map(s => [s.thumb, s]))
  const prevCovers = new Set(prev && prev.covers || [])
  const info = {}
  const cards = page.locator('.screens .reference-screen')
  const n = await cards.count()
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i)
    const src = await card.locator('img').first().evaluate(el => el.currentSrc || el.src).catch(() => '')
    if (!src || info[src]) continue
    const old = prevScreens.get(src)
    if (old) { info[src] = { color: old.color || [], cover: false }; continue }
    if (prevCovers.has(src)) { info[src] = { color: [], cover: true }; continue }
    try {
      await card.scrollIntoViewIfNeeded({ timeout: 5000 })
      await card.locator('img').first().evaluate(el => el.complete ? null : new Promise(r => { el.onload = el.onerror = r; setTimeout(r, 5000) }))
      const shot = await card.screenshot({ type: 'jpeg', quality: 80, timeout: 8000 })
      const a = await analyze(tool, shot)
      info[src] = { color: a.tags, cover: a.cover }
    } catch { info[src] = { color: [], cover: false } }
  }

  // 분류: 화면 목록이 지난번과 같으면 지난번 분류를 그대로 씀
  const same = prev && !RETAG && prev.screens.length && srcs.every(s => prevScreens.has(s) || prevCovers.has(s)) && prev.screens.every(s => srcs.includes(s.thumb))
  let tagMap
  if (NO_TAGS) tagMap = Object.fromEntries(srcs.map(s => [s, prevScreens.get(s)?.tags || []]))
  else if (same && prev.tagged) tagMap = Object.fromEntries(srcs.map(s => [s, prevScreens.get(s)?.tags || []]))
  else tagMap = await tagScreens(page, srcs)

  const screens = srcs.filter(s => !info[s]?.cover).map((thumb, i) => ({
    thumb, src: thumb.replace(/_small\.webp$/, '.webp'), order: i + 1,
    tags: tagMap[thumb] || [], color: info[thumb]?.color || []
  }))
  const covers = srcs.filter(s => info[s]?.cover)
  return { id, name: meta.name, desc: meta.desc, logo: meta.logo, url: `${SITE}/reference/service/${id}`, tagged: !NO_TAGS || !!(prev && prev.tagged), screens, covers }
}

// ── 결과 보기 페이지 (직접 실행했을 때 확인용) ──
function writePreview(data, file) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  fs.writeFileSync(file, `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>디자이너스 수집 결과</title><style>
body{margin:0;padding:24px 28px;background:#F5F6FA;font-family:Pretendard,'Malgun Gothic',sans-serif;color:#1A1A2E}h1{font-size:19px;margin:0 0 4px}.sub{font-size:12px;color:#888;margin-bottom:20px}
h2{font-size:15px;margin:26px 0 10px;display:flex;align-items:center;gap:8px}h2 img{width:28px;height:28px;border-radius:7px}h2 span{font-weight:400;font-size:12px;color:#999}
.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}.c{background:#fff;border:1px solid #E3E5EC;border-radius:10px;overflow:hidden;font-size:10px}
.c img{display:block;width:100%;aspect-ratio:9/19.5;object-fit:cover;object-position:top}.t{padding:6px;display:flex;flex-wrap:wrap;gap:3px}.t i{font-style:normal;background:#EEF4FF;color:#3A5BC7;padding:1px 5px;border-radius:8px}.t i.k{background:#F3F4F6;color:#666}
.f{background:#FFF7ED;border:1px solid #FED7AA;border-radius:10px;padding:10px 14px;font-size:12px;color:#92400E;margin-bottom:12px}</style></head><body>
<h1>디자이너스 수집 결과</h1><div class="sub">${esc(data.updated)} · 앱 ${data.apps.length}개 · 화면 ${data.apps.reduce((a, b) => a + b.screens.length, 0)}장</div>
${data.failed.length ? `<div class="f">모으지 못한 앱 ${data.failed.length}개: ${data.failed.map(f => esc(f.id + ' ' + f.error)).join(' / ')}</div>` : ''}
${data.apps.map(a => `<h2><img src="${esc(a.logo)}" alt="">${esc(a.name)}<span>${a.screens.length}장 · ${esc(a.desc)}</span></h2><div class="g">${a.screens.map(s => `<div class="c"><a href="${esc(s.src)}" target="_blank"><img src="${esc(s.thumb)}" loading="lazy"></a><div class="t">${s.tags.map(t => `<i>${esc(t)}</i>`).join('')}${s.color.map(t => `<i class="k">${esc(t)}</i>`).join('')}</div></div>`).join('')}</div>`).join('')}
</body></html>`)
}

// ── 실행 ──
;(async () => {
  let prev = null
  try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')) } catch {}
  const prevApps = new Map((prev && prev.apps || []).map(a => [String(a.id), a]))

  let browser = null
  const tries = process.env.PC_BROWSER === 'chromium' ? [{}] : [{ channel: 'msedge' }, { channel: 'chrome' }, {}]
  for (const o of tries) { try { browser = await pw.chromium.launch({ headless: true, ...o }); break } catch {} }
  if (!browser) { console.log('브라우저(Edge/Chrome)를 찾지 못했어요.'); process.exit(1) }
  const tmp = await browser.newPage(); const ua = (await tmp.evaluate(() => navigator.userAgent)).replace(/Headless/g, ''); await tmp.close()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: ua, locale: 'ko-KR', timezoneId: 'Asia/Seoul' })
  const page = await ctx.newPage()
  const tool = await ctx.newPage()

  let ids = await appIds(page)
  if (LIMIT) ids = ids.slice(0, LIMIT)
  console.log(`\n디자이너스 수집 시작 — 앱 ${ids.length}개${NO_TAGS ? ' (분류 건너뜀)' : ''}\n`)
  const apps = [], failed = []
  for (const [i, id] of ids.entries()) {
    try {
      const a = await collectApp(page, tool, id, prevApps.get(String(id)))
      apps.push(a)
      const tagged = a.screens.filter(s => s.tags.length).length
      console.log(`  ✓ [${i + 1}/${ids.length}] ${a.name}  화면 ${a.screens.length}장, 분류된 화면 ${tagged}장`)
    } catch (e) {
      failed.push({ id, error: String(e.message || e).split('\n')[0] })
      console.log(`  ✗ [${i + 1}/${ids.length}] 앱 ${id} — ${failed[failed.length - 1].error}`)
      const old = prevApps.get(String(id)); if (old) apps.push(old)   // 실패하면 지난번 것을 유지
    }
    await wait(PAUSE)
  }
  await browser.close()

  const data = { source: 'designus', site: SITE, updated: new Date().toISOString(), apps, failed }
  const screens = apps.reduce((n, a) => n + a.screens.length, 0)
  // 안전장치: 지난번보다 크게 줄었으면 저장하지 않음 (시범 실행은 예외)
  if (!LIMIT && prev && prev.apps) {
    const pScreens = prev.apps.reduce((n, a) => n + a.screens.length, 0)
    if (apps.length < prev.apps.length * 0.6 || screens < pScreens * 0.6) {
      console.log(`\n[중단] 지난번(앱 ${prev.apps.length}개, 화면 ${pScreens}장)보다 크게 줄었어요 (앱 ${apps.length}개, 화면 ${screens}장). 사이트 구조가 바뀌었을 수 있어 저장하지 않았습니다.\n`)
      process.exit(2)
    }
  }
  if (!apps.length) { console.log('\n[중단] 모은 앱이 없어요.\n'); process.exit(2) }
  if (failed.length >= Math.max(2, ids.length * 0.3)) {
    console.log(`\n[중단] 앱 ${ids.length}개 중 ${failed.length}개를 모으지 못했어요. 사이트 구조가 바뀌었을 수 있어 저장하지 않았습니다.\n`)
    process.exit(2)
  }
  fs.writeFileSync(OUT, JSON.stringify(data))
  const preview = OUT.replace(/\.json$/, '_preview.html')
  if (!process.env.CI) writePreview(data, preview)
  console.log(`\n완료: 앱 ${apps.length}개, 화면 ${screens}장${failed.length ? `, 실패 ${failed.length}개` : ''}`)
  console.log(`저장: ${OUT}`)
  if (!process.env.CI) console.log(`결과 보기: ${preview}\n`)
})().catch(e => { console.error('\n오류:', e.message); process.exit(1) })
