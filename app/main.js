const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path   = require('path')
const https  = require('https')
const http   = require('http')
const fs     = require('fs')
const os     = require('os')
const crypto = require('crypto')
const zlib   = require('zlib')

// ── Electron userData 경로를 별도 폴더로 분리 (최상단에서 설정해야 적용됨)
// Electron이 Buchji 루트를 건드리지 않도록
app.setPath('userData', path.join(os.homedir(), 'AppData', 'Roaming', 'Bucci', 'electron'))

// ── 경로 ─────────────────────────────────────────────────────────────
// AppData\Local\BucciData - Electron이 절대 건드리지 않는 경로
const APP_DATA = path.join(os.homedir(), 'AppData', 'Local', 'BucciData')

// 한글 폴더(부찌) → Buchji 자동 마이그레이션
;(function migrateOldCache() {
  try {
    fs.mkdirSync(APP_DATA, { recursive: true })
    // 기존 Roaming\Buchji의 캐시 파일들 → Local\BucciData로 이동
    const oldDirs = [
      path.join(os.homedir(), 'AppData', 'Roaming', 'Bucci'),
      path.join(os.homedir(), 'AppData', 'Roaming', '부찌'),
    ]
    const migrateFiles = ['url_cache.json', 'usecase_cache.json', 'collections.json']
    oldDirs.forEach(oldDir => {
      if (!fs.existsSync(oldDir)) return
      migrateFiles.forEach(f => {
        const src = path.join(oldDir, f)
        const dst = path.join(APP_DATA, f)
        try {
          if (fs.existsSync(src) && !fs.existsSync(dst)) {
            fs.copyFileSync(src, dst)
            fs.unlinkSync(src)
            console.log('[migrate]', f, '→ BucciData')
          }
        } catch {}
      })
      // img_cache 폴더도 이동
      const imgSrc = path.join(oldDir, 'img_cache')
      const imgDst = path.join(APP_DATA, 'img_cache')
      if (fs.existsSync(imgSrc) && !fs.existsSync(imgDst)) {
        try { fs.renameSync(imgSrc, imgDst); console.log('[migrate] img_cache → BucciData') } catch {}
      }
    })
  } catch(e) { console.log('[migrate error]', e.message) }
})()
const CACHE_JSON    = path.join(APP_DATA, 'url_cache.json')
const UC_CACHE_JSON = path.join(APP_DATA, 'usecase_cache.json')
const IMG_CACHE     = path.join(APP_DATA, 'img_cache')
;[APP_DATA, IMG_CACHE].forEach(d => { try { fs.mkdirSync(d, { recursive: true }) } catch {} })

// ── 캐시 ─────────────────────────────────────────────────────────────
const CACHE_TTL = 365 * 24 * 60 * 60 * 1000  // 1년 (사실상 무제한, 수동 리로드로만 갱신)
let urlCache = { apps: {}, paths: {}, updated: 0 }
let ucCache  = []   // use-case 배열

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_JSON)) return false
    const data = JSON.parse(fs.readFileSync(CACHE_JSON, 'utf8'))
    if (Date.now() - (data.updated || 0) > CACHE_TTL) return false
    urlCache = data
    console.log('[cache] loaded:', Object.keys(urlCache.apps).length, 'apps')
    return true
  } catch { return false }
}

function saveCache() {
  try { fs.writeFileSync(CACHE_JSON, JSON.stringify(urlCache)) } catch {}
}

function loadUcCache() {
  try {
    if (!fs.existsSync(UC_CACHE_JSON)) return false
    const data = JSON.parse(fs.readFileSync(UC_CACHE_JSON, 'utf8'))
    if (Date.now() - (data.updated || 0) > CACHE_TTL) return false
    ucCache = data.items || []
    console.log('[uc-cache] loaded:', ucCache.length, 'use-cases')
    return true
  } catch { return false }
}

function saveUcCache() {
  try { fs.writeFileSync(UC_CACHE_JSON, JSON.stringify({ items: ucCache, updated: Date.now() })) }
  catch {}
}

function imgCachePath(url) {
  return path.join(IMG_CACHE, crypto.createHash('md5').update(url).digest('hex') + '.jpg')
}

// ── Electron userData 경로 강제 설정 (Buchji로 통일) ─────────────────
// ── 태그 DB ──────────────────────────────────────────────────────────
let tagsDb = {}
function loadTags() {
  try {
    const p = path.join(__dirname, 'tags.json')
    if (fs.existsSync(p)) tagsDb = JSON.parse(fs.readFileSync(p, 'utf8'))
    console.log('[tags] loaded:', Object.keys(tagsDb).length)
  } catch (e) { console.log('[tags] error:', e.message) }
}

// ── HTTP ─────────────────────────────────────────────────────────────
const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Accept-Encoding': 'identity',
  'Connection': 'close',
}

function fetchRaw(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const lib = url.startsWith('https') ? https : http
      const parsed = new URL(url)
      const req = lib.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: HDR }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location.startsWith('http') ? res.headers.location : `https://${parsed.hostname}${res.headers.location}`
          return fetchRaw(loc, timeout).then(resolve).catch(reject)
        }
        const chunks = []
        const enc = (res.headers['content-encoding'] || '').toLowerCase()
        let stream = res
        if (enc.includes('gzip'))    stream = res.pipe(zlib.createGunzip())
        else if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress())
        stream.on('data', c => chunks.push(c))
        stream.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
        stream.on('error', reject)
      })
      req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')) })
      req.on('error', reject)
    } catch (e) { reject(e) }
  })
}

async function fetchHtml(url) {
  try {
    // URL의 HTML 엔티티 디코딩 (&amp; → &)
    const cleanUrl = url.replace(/&amp;/g, '&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    const { status, body } = await fetchRaw(cleanUrl)
    if (status !== 200) return null
    return body.toString('utf8')
  } catch { return null }
}

async function fetchBinary(url) {
  try {
    const { status, body } = await fetchRaw(url)
    return status === 200 ? body : null
  } catch { return null }
}

// ── WWIT 파서 ────────────────────────────────────────────────────────
const WWIT_BASE = 'https://wwit.design/'

// 검색 결과에서 video 타입 제거 (영상은 별도 영상보기로만)
function sortDataByRelevance(data, kw) {
  if (!kw || !Object.keys(data).length) return data
  const kwl = kw.toLowerCase().trim()
  const kwWords = kwl.split(/\s+/).filter(Boolean)
  const scored = Object.entries(data).map(([name, items]) => {
    const nl = name.toLowerCase()
    let score = items.length * 0.1  // 이미지 수 영향 최소화
    if (nl === kwl) score += 1000              // 완전 일치 최우선
    else if (nl.startsWith(kwl)) score += 500  // 시작 일치
    else if (kwl.startsWith(nl)) score += 400  // 검색어가 앱명 포함
    else if (nl.includes(kwl)) score += 200    // 포함
    else {
      // 단어별 매칭
      const matchedWords = kwWords.filter(w => nl.includes(w) || nl.startsWith(w))
      if (matchedWords.length === kwWords.length) score += 150  // 모든 단어 매칭
      else if (matchedWords.length > 0) score += 50 * matchedWords.length
    }
    // 이름 길이 패널티 (짧을수록 정확한 검색어)
    if (score > 0) score -= nl.length * 0.5
    return [name, items, score]
  })
  scored.sort((a,b) => b[2]-a[2])
  const sorted = {}
  scored.forEach(([name, items]) => { sorted[name] = items })
  return sorted
}

function filterVideoItems(data) {
  const result = {}
  Object.entries(data).forEach(([k, items]) => {
    const filtered = items.filter(i => i.type !== 'video')
    if (filtered.length >= 1) result[k] = filtered  // 이미지 1개라도 있으면 유지
  })
  return result
}
const WWIT_EXCL = ['_logo','logo_','icon_','_icon','thumbnail','cover','.mov','.mp4','.svg']

function wwit_ok(url) {
  const f = url.split('/').pop().toLowerCase()
  return !WWIT_EXCL.some(e => f.includes(e))
}

function addUrl(src, filterSlug, groups) {
  if (!src || !src.includes('/images/posts/')) return
  // HTML 엔티티 디코딩
  src = src.replace(/&amp;/g, '&').replace(/&#38;/g, '&')
  try { src = decodeURIComponent(src) } catch {}
  const full = src.startsWith('http') ? src : WWIT_BASE + src.replace(/^\//, '')
  if (!wwit_ok(full)) return
  const parts = full.split('/')
  const pi = parts.findIndex(p => p === 'posts')
  if (pi < 0 || pi + 1 >= parts.length) return
  const slug = parts[pi + 1]
  if (!slug) return
  if (filterSlug && slug !== filterSlug) return
  if (!groups[slug]) groups[slug] = []
  if (!groups[slug].includes(full)) groups[slug].push(full)
}

function wwit_parse(html, filterSlug = null) {
  if (!html) return {}
  const groups = {}
  const re1 = /(?:src|data-src|data-original|data-lazy-src)=["']([^"'>]*?\/images\/posts\/[^"'>]+)["']/gi
  const re2 = /["']([^"']*?\/images\/posts\/[^"'\s\\]+)["']/g
  let m
  while ((m = re1.exec(html)) !== null) addUrl(m[1], filterSlug, groups)
  while ((m = re2.exec(html)) !== null) addUrl(m[1], filterSlug, groups)
  return groups
}

// ── WWIT 앱 DB ───────────────────────────────────────────────────────
const WWIT_APPS = [
  { slug:'alarmy',       name:'알라미',       page:'2025/04/06/alarmy',       kw:['알라미','alarmy','알람','기상','수면'] },
  { slug:'revolt',       name:'리볼트',       page:'2025/03/15/revolt',       kw:['리볼트','revolt','커머스','쇼핑','중고차'] },
  { slug:'mmm',          name:'mmm 엠엠엠',   page:'2025/03/04/mmm',          kw:['엠엠엠','mmm','라이프스타일'] },
  { slug:'npay',         name:'네이버페이',   page:'2025/02/15/npay',         kw:['네이버페이','npay','네이버','결제','금융'] },
  { slug:'wrtn',         name:'뤼튼',         page:'2024/12/24/wrtn',         kw:['뤼튼','wrtn','ai','인공지능','챗봇'] },
  { slug:'3o3',          name:'삼쩜삼',       page:'2024/11/03/3o3',          kw:['삼쩜삼','3o3','세금','환급','금융'] },
  { slug:'chzzk',        name:'치지직',       page:'2024/01/13/chzzk',        kw:['치지직','chzzk','스트리밍','방송','네이버'] },
  { slug:'dotslashdash', name:'닷슬래시대시', page:'2023/09/30/dotslashdash', kw:['닷슬래시대시','dotslashdash','생산성'] },
  { slug:'planfit',      name:'플랜핏',       page:'2023/07/24/planfit',      kw:['플랜핏','planfit','운동','헬스','피트니스'] },
  { slug:'heydealer',    name:'헤이딜러',     page:'2023/04/04/heydealer',    kw:['헤이딜러','heydealer','중고차','자동차'] },
  { slug:'pillyze',      name:'필라이즈',     page:'2022/12/19/pillyze',      kw:['필라이즈','pillyze','영양제','건강'] },
  { slug:'shinhanplay',  name:'신한플레이',   page:'2022/10/28/shinhanplay',  kw:['신한플레이','shinhanplay','신한','금융','카드'] },
  { slug:'lgthinq',      name:'LG ThinQ',    page:'2022/07/31/lgthinq',      kw:['lgthinq','thinq','lg','스마트홈','가전'] },
  { slug:'monimo',       name:'모니모',       page:'2022/07/16/monimo',       kw:['모니모','monimo','삼성','금융','뱅킹'] },
  { slug:'ohouse',       name:'오늘의집',     page:'2022/06/05/ohouse',       kw:['오늘의집','ohouse','인테리어','홈'] },
  { slug:'baemin',       name:'배달의민족',   page:'2022/04/04/baemin',       kw:['배달의민족','배민','baemin','배달','음식'] },
  { slug:'kakaot',       name:'카카오T',      page:'2021/06/06/kakaot',       kw:['카카오t','카카오','kakao','kakaot','택시','모빌리티'] },
  { slug:'cardoc',       name:'카닥',         page:'2021/04/12/cardoc',       kw:['카닥','cardoc','자동차','정비'] },
  { slug:'heymoon',      name:'헤이문',       page:'2021/03/28/heymoon',      kw:['헤이문','heymoon','명상','건강'] },
  { slug:'lifeplus',     name:'라이프플러스', page:'2021/02/16/lifeplus',     kw:['라이프플러스','lifeplus','보험','금융'] },
  { slug:'tada',         name:'타다',         page:'2022/01/23/tada',         kw:['타다','tada','택시','모빌리티'] },
  { slug:'ruiiidtutor',  name:'뤼이드 튜터',  page:'2021/07/26/ruiiidtutor',  kw:['뤼이드','뤼이드튜터','ruiiid','ruiiidtutor','tutor','교육','영어','학습'] },
  // ── tags.json에 있는 추가 앱 (page는 tagsDb fallback으로 로드) ──────
  { slug:'toss',         name:'토스',         page:'',                        kw:['토스','toss','금융','송금','뱅킹','간편결제'] },
  { slug:'kakaopay',     name:'카카오페이',   page:'',                        kw:['카카오페이','kakaopay','결제','금융','송금'] },
  { slug:'banksalad',    name:'뱅크샐러드',   page:'',                        kw:['뱅크샐러드','banksalad','금융','자산관리'] },
  { slug:'coupang',      name:'쿠팡',         page:'',                        kw:['쿠팡','coupang','커머스','쇼핑','배달'] },
  { slug:'kream',        name:'크림',         page:'',                        kw:['크림','kream','리셀','스니커즈','한정판'] },
  { slug:'29cm',         name:'29CM',         page:'',                        kw:['29cm','커머스','패션','라이프스타일'] },
  { slug:'zigzag',       name:'지그재그',     page:'',                        kw:['지그재그','zigzag','패션','여성쇼핑'] },
  { slug:'marketkurly',  name:'마켓컬리',     page:'',                        kw:['마켓컬리','marketkurly','컬리','식품','새벽배송'] },
  { slug:'dgmarket',     name:'당근마켓',     page:'',                        kw:['당근마켓','dgmarket','당근','중고거래'] },
  { slug:'zepeto',       name:'제페토',       page:'',                        kw:['제페토','zepeto','메타버스','아바타'] },
  { slug:'vlive',        name:'V LIVE',       page:'',                        kw:['vlive','v live','브이라이브','k팝','스트리밍'] },
  { slug:'kakaowebtoon', name:'카카오웹툰',   page:'',                        kw:['카카오웹툰','kakaowebtoon','웹툰','만화'] },
  { slug:'daumwebtoon',  name:'다음웹툰',     page:'',                        kw:['다음웹툰','daumwebtoon','웹툰','만화'] },
  { slug:'millie',       name:'밀리',         page:'',                        kw:['밀리','millie','전자책','독서'] },
  { slug:'coinone',      name:'코인원',       page:'',                        kw:['코인원','coinone','암호화폐','가상화폐','거래소'] },
  { slug:'starbucks',    name:'스타벅스',     page:'',                        kw:['스타벅스','starbucks','커피','음료','주문'] },
  { slug:'flo',          name:'플로',         page:'',                        kw:['플로','flo','음악','스트리밍','뮤직'] },
  { slug:'hogangnono',   name:'호갱노노',     page:'',                        kw:['호갱노노','hogangnono','부동산','아파트'] },
  { slug:'zigbang',      name:'직방',         page:'',                        kw:['직방','zigbang','부동산','원룸','아파트'] },
  { slug:'laundrygo',    name:'런드리고',     page:'',                        kw:['런드리고','laundrygo','세탁','배달세탁'] },
  { slug:'trost',        name:'트로스트',     page:'',                        kw:['트로스트','trost','심리상담','멘탈헬스'] },
  { slug:'texture',      name:'텍스처',       page:'',                        kw:['텍스처','texture','패션','스타일'] },
  { slug:'miso',         name:'미소',         page:'',                        kw:['미소','miso','홈클리닝','청소','가사'] },
  { slug:'setak',        name:'세탁특공대',   page:'',                        kw:['세탁특공대','세탁','laundry'] },
  { slug:'domino',       name:'도미노',       page:'',                        kw:['도미노','domino','피자','배달','주문'] },
  { slug:'ministock',    name:'미니스탁',     page:'',                        kw:['미니스탁','ministock','주식','소수점','투자'] },
  { slug:'bomapp',       name:'봄앱',         page:'',                        kw:['봄앱','bomapp','금융','보험'] },
  { slug:'finnq',        name:'핀크',         page:'',                        kw:['핀크','finnq','금융','간편결제'] },
  { slug:'imin',         name:'이민',         page:'',                        kw:['이민','imin','금융','해외송금'] },
  { slug:'cashslide',    name:'캐시슬라이드', page:'',                        kw:['캐시슬라이드','cashslide','리워드','잠금화면'] },
  { slug:'elephant',     name:'엘리펀트',     page:'',                        kw:['엘리펀트','elephant','영어','학습','교육'] },
  { slug:'dive',         name:'다이브',       page:'',                        kw:['다이브','dive','OTT','콘텐츠'] },
  { slug:'chai',         name:'차이',         page:'',                        kw:['차이','chai','결제','간편결제','금융'] },
  { slug:'cardoc06_comm',name:'카닥커뮤니티', page:'',                        kw:['카닥커뮤니티','cardoc','자동차','커뮤니티'] },
]

const slug2name = Object.fromEntries(WWIT_APPS.map(a => [a.slug, a.name]))

// 전체 앱 한글 이름 매핑 (누락 없음)
const EXTRA_NAMES = {
  'pillyze':'필라이즈','shinhanplay':'신한플레이','monimo':'모니모',
  'baemin':'배달의민족','ohouse':'오늘의집','kakaopay':'카카오페이',
  'toss':'토스','banksalad':'뱅크샐러드','coupang':'쿠팡',
  'kream':'크림','29cm':'29CM','zigzag':'지그재그',
  'marketkurly':'마켓컬리','heymoon':'헤이문','cardoc':'카닥',
  'trost':'트로스트','hogangnono':'호갱노노','zigbang':'직방',
  'laundrygo':'런드리고','flo':'플로','vlive':'V LIVE',
  'kakaowebtoon':'카카오웹툰','daumwebtoon':'다음웹툰','millie':'밀리',
  'coinone':'코인원','starbucks':'스타벅스','texture':'텍스처',
  'miso':'미소','setak':'세탁특공대','domino':'도미노',
  'ministock':'미니스탁','bomapp':'봄앱','finnq':'핀크',
  'imin':'이민','cashslide':'캐시슬라이드','elephant':'엘리펀트',
  'dive':'다이브','ruiiidtutor':'뤼이드 튜터','dgmarket':'당근마켓','당근':'당근마켓',
  'zepeto':'제페토','chai':'차이','cardoc06_comm':'카닥커뮤니티',
}
Object.assign(slug2name, EXTRA_NAMES)
// WWIT_APPS의 slug→name도 추가
WWIT_APPS.forEach(a => { if (!slug2name[a.slug]) slug2name[a.slug] = a.name })

const name2slug = Object.fromEntries(WWIT_APPS.map(a => [a.name, a.slug]))
Object.entries(EXTRA_NAMES).forEach(([s,n]) => { name2slug[n] = s })

// UPA 앱 이름 → 카테고리 직접 매핑 (421개 앱)
const UPA_APP_CATEGORIES = {
  '금융/핀테크': new Set(['KB스타뱅킹','KBPay','모니모','토스','네이버페이','카카오페이','카카오뱅크','뱅크샐러드','삼쩜삼','하나머니','하나은행','신한SOL뱅크','i-ONE Bank','우체국뱅킹','현대카드','현대카드 다이브','롯데카드','페이코','서울Pay','삼성월렛','케이패스','티머니GO','티머니카드&페이','엘포인트','오케이캐쉬백','해피포인트','CJ ONE','신세계포인트','h.point','KT 멤버십','핀크','핀트','발로소득','머니워크','캐시워크','캐시닥','캐시미션','캐시보카','엠브레인 패널파워','패널나우','가치워크','슈퍼워크','포켓CU','편한가계부','하우머치','보닥','현대캐피탈 카앤에셋','페이북','도미노','니콘내콘','기프티스타','해피오더','윙잇','폴센트','발라랩','마이디','그리팅','지니어트','웰로','멤버쉽 위젯','피클플러스','올클']),
  '커머스/쇼핑': new Set(['쿠팡','마켓컬리','SSG.COM','지마켓','11번가','옥션','티몬','홈플러스','이마트','이마트24','GS SHOP','하이마트','알리익스프레스','테무','쉬인','자라','무신사','에이블리','지그재그','29cm','크림','W컨셉','브랜디','온더룩','올리브영','화해','강남언니','바비톡','아이디어스','텐바이텐','하프클럽','인터파크','공구마켓','굿웨어몰','샵스캐너','에누리가격비교','뮬','뮬리','핀터레스트','나이키','스타벅스','컴포즈커피','이디야','빽다방','할리스','CGV','인터파크 티켓','멜론티켓','YES24','알라딘','번개장터','중고나라','당근','올웨이즈','오락','하이버','오베이','팔라고','타바라','와디즈','리브애니웨어','플러스팟','파브','마이로','미니모어맥스','라운즈']),
  '배달/푸드': new Set(['배달의민족','요기요','쿠팡이츠','땡겨요','라스트오더','해피오더','우리동네GS','엽기떡볶이','거꾸로 레시피','우리의식탁','패스오더','캐치테이블','테이블링','점신','푸망']),
  '모빌리티': new Set(['카카오T','티맵','T맵','카카오맵','카카오지하철','코레일톡','UT','우버(Uber)','서울자전거 따릉이','스윙','지쿠','쏘카 일레클','그랩','티머니GO','모두의 주차장','지하철매니저','스마트택배','짐싸','헤이딜러','오일나우','가스앱']),
  '엔터테인먼트': new Set(['유튜브','넷플릭스','티빙','웨이브','왓챠피디아','라프텔','유튜브 뮤직','멜론','지니뮤직','스포티파이','플로','벅스','애플뮤직','SoundCloud','MBC라디오','오디오클립','팟캐스트(iOS)','네이버 웹툰','네이버웹툰','카카오웹툰','리디','시리즈','카카오페이지','숏챠','스토리플레이','틱톡','제페토','위버스','치지직','인스티즈','오즈의 타로','피크민 블룸','포토그레이','스쿱','the day before','비니티','DOSI(도시)','여신티켓','사운드 하운드','퍼핀']),
  '라이프스타일': new Set(['오늘의 집','당근','번개장터','중고나라','캐럿','썸원','데이트팝','문토','프립','솜씨당','핑크다이어리','무디','베터','하루','일기(iOS)','해마 일기','답다','cherish','포스티','비주얼 타이머','선라이즈','봄캘린더','Google 캘린더','투두메이트','챌린저스','루티너리','마이루틴','미라클나잇','하루콩','제때','나의 물','날씨날씨','미세미세','네이버 지도','카카오맵','청소연구소','우쥬테스트','헤이문','유플래너','빼기','차란','마인디','오프메이트','성경']),
  '부동산': new Set(['직방','집토스','호갱노노','네이버부동산','내집다오','부동부동','빠방','아파트아이','집품','하우머치']),
  '헬스/피트니스': new Set(['플랜핏','필라이즈','런데이','나이키 런 클럽','Aaptiv','Samsung Health','건강(iOS)','피트니스(iOS)','StressWatch(iOS)','인바디','힐리어리','올라케어','닥터나우','나만의닥터','애니핏플러스','인사이트 타이머','하루명상','마인드카페','마인들링','사운드짐','딥워크','텐퍼센트','밸런스프렌즈','스포애니 멤버십','김캐디','FocusPomo','포커스 플랜트','SmartThings','LGthinQ','측정(아이폰)']),
  '생산성': new Set(['뤼튼','ChatGPT','퍼플렉시티','에이닷','구글어시스턴트','시리','네이버 클로바','클로바 노트','노션','슬랙','리멤버','원티드','잡코리아','알바천국','사람인','크몽','숨고','클래스101','인프런','말해보카','스픽','케이크','듀오링고','헬로우톡','그래마리','파파고','Google 번역','구글 번역','플리토','콴다','수학대왕','파트타임스터디','커리어리','VITA','캡컷','VLLO','Meitu','스노우','피그마','어도비 스캔','구글 스프레드 시트','구글 태스크','App Store','daglo','워크마이닝','타임스프레드','타임블럭','도트타이머','토글트랙','열품타','서베이링크','서베이몽키','윗치폼','브이플랫','미디엄','리드로그','리드','간단','에픽','포모코','뉴뉴','블림프','프레잼','프레딧','이닛','아이엠','클로디','채글','플릭','구글 포토','네이버 스마트보드','서울디자인소사이어티','테서랙트','계산기(아이폰)']),
  '소셜/커뮤니티': new Set(['인스타그램','페이스북','트위터','스레드','틱톡','디스코드','텔레그램','카카오톡','네이버밴드','네이버 카페','다음카페','에브리타임','블라인드','위버스','인사이드','커피챗','속닥','소다','헤이폴','문토','채글','보윙','워너아이','팝앤팝','비글루','모지또','뉴밍','럭키비키','럭키밀','티니위키','가나다','틴더','카카오헤어샵','헬로우봇','당신의U+(고객센터)']),
  '포털/검색': new Set(['네이버','다음','구글','네이버메일','네이버 블로그','네이버스','뉴닉','아하','퍼플렉시티']),
  '여행/숙박': new Set(['에어비앤비','야놀자','여기어때','데일리호텔','마이리얼트립','트립어드바이저','트립닷컴','아고다','트리플','트립소다','진에어','대한항공My','코레일톡','그랩','투래빗','데이트립']),
  '교육/육아': new Set(['클래스101','인프런','콴다','수학대왕','말해보카','스픽','케이크','듀오링고','헬로우톡','그래마리','파트타임스터디','윌라','밀리의 서재','오디오클립','북적북적','베이비빌리','맘맘','차일디','꾸주니','너티','우쥬테스트','뉴밍','리드로그','열품타','인아웃']),
  '반려동물': new Set(['펫프렌즈','펫토그램','피리부는 강아지']),
}

// UPA 앱이름으로 카테고리 찾기
function getUpaCategory(appName) {
  for (const [cat, apps] of Object.entries(UPA_APP_CATEGORIES)) {
    if (apps.has(appName)) return cat
  }
  return null
}

// UPA_CAT_KEYWORDS는 하위호환용으로 유지
const UPA_CAT_KEYWORDS = {}

// 컴포넌트 태그 매핑
const COMPONENT_TAG_MAP = {
  '달력/날짜':     ['캘린더','날짜선택','일정'],
  '토글/스위치':   ['설정','환경설정'],
  '태그/칩':       ['필터','선택','셀렉트'],
  '빈 상태':       ['빈화면','에러'],
  '드롭다운':      ['드롭다운','셀렉트','선택'],
  '검색바':        ['검색바','검색','필터'],
  '탭/네비게이션': ['탭','탭바','GNB','네비게이션'],
  '바텀시트':      ['바텀시트','모달'],
  '팝업/모달':     ['팝업','다이얼로그','모달'],
  '입력/폼':       ['입력','텍스트필드','폼'],
  '차트/통계':     ['차트','그래프','통계'],
  '뱃지/알림점':   ['노티','알림'],
}

// WWIT slug 기반 카테고리
const CATEGORY_SLUGS = {
  '금융/핀테크':    ['toss','banksalad','kakaopay','npay','shinhanplay','monimo','3o3','coinone','finnq','bomapp','imin','domino','ministock','chai','lifeplus'],
  '커머스/쇼핑':    ['coupang','kream','29cm','zigzag','marketkurly','ohouse','revolt','starbucks'],
  '배달/푸드':      ['baemin','miso','setak','laundrygo'],
  '모빌리티':       ['kakaot','tada','heydealer','cardoc'],
  '엔터테인먼트':   ['chzzk','vlive','kakaowebtoon','daumwebtoon','millie','flo','zepeto','dive','elephant'],
  '라이프스타일':   ['alarmy','heymoon','mmm','lgthinq','trost','cashslide','texture','dgmarket'],
  '부동산':         ['zigbang','hogangnono'],
  '헬스/피트니스':  ['planfit','pillyze'],
  '생산성':         ['wrtn','dotslashdash','ruiiidtutor'],
  '소셜/커뮤니티':  [],
  '포털/검색':      [],
  '여행/숙박':      [],
  '교육/육아':      ['ruiiidtutor'],
  '반려동물':       [],
}

const WWIT_PATHS = {
  // 앱 유형 카테고리
  '금융/핀테크':'cat/finance','커머스/쇼핑':'cat/commerce','배달/푸드':'cat/delivery',
  '모빌리티':'cat/mobility','엔터테인먼트':'cat/entertainment','라이프스타일':'cat/lifestyle',
  '부동산':'cat/realestate','헬스/피트니스':'cat/health','생산성':'cat/productivity',
  '소셜/커뮤니티':'cat/social','포털/검색':'cat/portal',
  '여행/숙박':'cat/travel','교육/육아':'cat/education','반려동물':'cat/pet',
  // 화면 패턴
  '스플래시/온보딩':'pattern/splash','로그인/회원가입':'pattern/signin',
  '홈화면':'pattern/home','홈 화면':'pattern/home','검색/필터':'pattern/search','알림':'pattern/notification',
  '주문/결제':'pattern/order','마이페이지':'pattern/mypage','설정':'pattern/setting',
  '리뷰':'pattern/review','로딩':'pattern/loading','성공/완료':'pattern/success',
  '장바구니':'pattern/cart','리스트':'pattern/list','비밀번호':'pattern/password',
  '이용약관':'pattern/t&c','선택':'pattern/select',
  // 컴포넌트
  '탭/네비게이션':'component/tab','바텀시트':'component/bottomsheet',
  '팝업/모달':'component/popup','입력/폼':'component/input','차트/통계':'component/chart',
  // 기존 호환
  '스플래시':'pattern/splash','로그인':'pattern/signin','회원가입':'pattern/signup',
  '온보딩':'pattern/onboarding','홈':'pattern/home','검색':'pattern/search',
  '스켈레톤':'pattern/loading','완료':'pattern/success','주문':'pattern/order',
  '결제':'pattern/order','입력':'component/input','탭':'component/tab','팝업':'component/popup',
}

const WWIT_ALL_PATHS = [
  'tag/life','tag/finance','tag/commerce','tag/realestate','tag/delivery','tag/entertainment','tag/mobility',
  'pattern/splash','pattern/signin','pattern/signup','pattern/onboarding','pattern/home','pattern/search',
  'pattern/notification','pattern/select','pattern/loading','pattern/success','pattern/cart','pattern/order',
  'pattern/list','pattern/review','pattern/password','pattern/t&c','pattern/mypage','pattern/setting',
  'component/input','component/tab','component/bottomsheet','component/popup','component/chart',
]

// 홈화면 패턴 강제 로드 (캐시에 없을 경우)
async function ensureHomePattern() {
  const existing = urlCache.paths['pattern/home']
  const hasData = existing && Object.keys(existing).length > 0

  if (!hasData) {
    console.log('[home] fetching pattern/home...')
    const html = await fetchHtml(WWIT_BASE + 'pattern/home')
    if (html) {
      const groups = wwit_parse(html)
      console.log('[home] parsed groups:', Object.keys(groups))
      if (Object.keys(groups).length) {
        urlCache.paths['pattern/home'] = groups
        saveCache()
        console.log('[home] saved', Object.keys(groups).length, 'app groups')
      } else {
        console.log('[home] no groups found in pattern/home')
      }
    } else {
      console.log('[home] fetch failed')
    }
  } else {
    console.log('[home] cache ok:', Object.keys(existing).length, 'groups')
  }
}

// ── UPA use-case 파서 (HTML 직접 파싱) ───────────────────────────────
async function parseUseCase(uid) {
  const html = await fetchHtml(`https://upa.userspoon.com/use-case/${uid}`)
  if (!html) return null

  // title: "유즈케이스 제목 | UPA"
  const titleM = html.match(/<title>([^<]+)\s*\|\s*UPA<\/title>/)
  const title   = titleM ? titleM[1].trim() : ''

  // h4: "앱이름 | 산업군"
  let appName = '', industry = ''
  const h4M = html.match(/<h4[^>]*>([^<|]+?)\s*\|\s*([^<]+?)<\/h4>/)
  if (h4M) { appName = h4M[1].trim(); industry = h4M[2].trim() }

  // images from wouldyoutest CDN
  const imgRe = /src="(https:\/\/assets\.wouldyoutest\.com\/upa\/[^"]+)"/g
  const images = []
  const seen   = new Set()
  let hasLogo  = false   // 정사각형 로고 이미지 1개만 허용
  let m
  while ((m = imgRe.exec(html)) !== null) {
    const src = m[1]
    if (!seen.has(src) && !src.includes('og_image')) {
      seen.add(src)
      const altM = html.slice(Math.max(0, html.indexOf(src) - 100), html.indexOf(src)).match(/alt="([^"]*)"/)
      const screenName = altM ? altM[1].trim() : ''

      // 정사각형 로고 감지: img 태그에서 width/height 추출
      const tagStart = html.lastIndexOf('<img', html.indexOf(src))
      const tagEnd   = html.indexOf('>', tagStart) + 1
      const tag      = html.slice(tagStart, tagEnd)
      const wM = tag.match(/width[^=]*=["\s]*(\d+)/)
      const hM = tag.match(/height[^=]*=["\s]*(\d+)/)
      const w  = wM ? parseInt(wM[1]) : 0
      const h  = hM ? parseInt(hM[1]) : 0
      const isSquare = w > 0 && h > 0 && Math.abs(w - h) <= 10 && w >= 200

      if (isSquare) {
        if (hasLogo) continue   // 이미 로고 1개 있으면 스킵
        hasLogo = true
      }
      images.push({ src, screenName, isLogo: isSquare })
    }
  }

  if (!appName && !images.length) return null

  return { id: uid, title, appName, industry, images, url: `https://upa.userspoon.com/use-case/${uid}`, hasMedia: html.includes('img.media') || html.includes('class="media"') }
}

// ── use-case 전체 수집 ────────────────────────────────────────────────
const UC_MAX_ID   = 1820
const UC_BATCH    = 20

async function buildUseCaseCache(splashWin) {
  const results = []
  let done = 0
  console.log('[uc] starting 1~', UC_MAX_ID)

  for (let start = 1; start <= UC_MAX_ID; start += UC_BATCH) {
    const ids   = Array.from({ length: Math.min(UC_BATCH, UC_MAX_ID - start + 1) }, (_, i) => start + i)
    const batch = await Promise.all(ids.map(async id => {
      try { return await parseUseCase(id) } catch { return null }
    }))
    batch.forEach(r => { if (r) results.push(r) })
    done += ids.length
    const pct = Math.round(done / UC_MAX_ID * 100)
    const payload = { done, total: UC_MAX_ID, pct, found: results.length }
    win?.webContents.send('uc-progress', payload)
    splashWin?.webContents.send('splash-uc-progress', payload)
    console.log(`[uc] ${pct}% (${done}/${UC_MAX_ID}) found: ${results.length}`)
  }

  // 3번: 앱 기준 정사각형 로고 이미지 전역 중복 제거
  const appLogoSeen = new Set()
  results.forEach(uc => {
    uc.images = uc.images.filter(img => {
      if (!img.isLogo) return true
      const key = uc.appName + '_logo'
      if (appLogoSeen.has(key)) return false
      appLogoSeen.add(key)
      return true
    })
  })

  ucCache = results.filter(uc => uc.images.length > 0)
  saveUcCache()
  win?.webContents.send('uc-done', { count: ucCache.length })
  splashWin?.webContents.send('splash-uc-done', { count: ucCache.length })
  console.log('[uc] done:', ucCache.length, 'use-cases')
  return ucCache
}

// ── UPA 카테고리 ──────────────────────────────────────────────────────
const UPA_CATEGORIES = [
  { id:47, name:'AI 보조' }, { id:50, name:'건강 관리' }, { id:45, name:'검색 기록' },
  { id:7,  name:'검색/필터' }, { id:15, name:'결제' }, { id:17, name:'고객 지원' },
  { id:12, name:'공유하기' }, { id:29, name:'광고' }, { id:18, name:'구독' },
  { id:6,  name:'내 정보' }, { id:23, name:'네비게이션' }, { id:4,  name:'로그인' },
  { id:8,  name:'리뷰/평가' }, { id:25, name:'리워드 교환' }, { id:26, name:'미니 게임' },
  { id:24, name:'미션 수행' }, { id:46, name:'번역' }, { id:14, name:'상품 구매' },
  { id:13, name:'상품 탐색/추천' }, { id:41, name:'선물하기' }, { id:10, name:'설정' },
  { id:28, name:'송금' }, { id:1,  name:'스플래시 스크린' }, { id:51, name:'아카이빙' },
  { id:9,  name:'알림' }, { id:33, name:'예약' }, { id:30, name:'오프라인 지원' },
  { id:2,  name:'온보딩' }, { id:37, name:'위젯' }, { id:49, name:'이용 내역' },
  { id:19, name:'일정/목표 관리' }, { id:20, name:'자산 관리' }, { id:38, name:'장바구니' },
  { id:11, name:'즐겨찾기' }, { id:31, name:'친구 초대' }, { id:16, name:'커뮤니케이션' },
  { id:21, name:'콘텐츠 제작' }, { id:22, name:'콘텐츠 탐색/추천' }, { id:42, name:'클라우드 동기화' },
  { id:43, name:'파일 조회/관리' }, { id:27, name:'팔로우' }, { id:34, name:'포인트 충전' },
  { id:40, name:'프로필' }, { id:32, name:'학습' }, { id:5, name:'홈' },
  { id:39, name:'회원 탈퇴' }, { id:3, name:'회원가입' },
]

// ── UPA hidden window (패턴 페이지용) ────────────────────────────────
let upaWin = null
function getUpaWin() {
  if (upaWin && !upaWin.isDestroyed()) return upaWin
  upaWin = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, webSecurity: false }
  })
  return upaWin
}

async function upa_scrape_category(catId, catName) {
  return new Promise(resolve => {
    const w = getUpaWin()
    const videoUrls = new Map()

    // B방법: 네트워크 요청 감시로 영상 URL 캐치
    try {
      w.webContents.session.webRequest.onBeforeRequest(
        { urls: ['*://*.mp4*','*://*.webm*','*userspoon*video*','*cloudfront*'] },
        (details) => { if (!videoUrls.has(details.url)) videoUrls.set(details.url, true) }
      )
    } catch {}

    const timeout = setTimeout(() => {
      try { w.webContents.session.webRequest.onBeforeRequest(null) } catch {}
      resolve({ cat: catName, items: [] })
    }, 30000)

    w.loadURL(`https://upa.userspoon.com/?uxPatternIds=${catId}`)
    w.webContents.once('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, 3500))

        const items = await w.webContents.executeJavaScript(`
          (function() {
            const result = [], seen = new Set()
            function getAppInfo(el) {
              const nodes = []
              const walk = (n) => { if (n.nodeType===3 && n.textContent.trim()) nodes.push(n.textContent.trim()); n.childNodes.forEach(walk) }
              walk(el)
              for (const t of nodes) {
                const m = t.match(/^([^|\\n]{1,30})\\s*\\|\\s*(.{1,30})$/)
                if (m) return { appName: m[1].trim(), appCategory: m[2].trim() }
              }
              return { appName: '', appCategory: '' }
            }
            const selectors = ['[class*="css-1pg6uaj"]','[class*="PatternCard"]','[class*="pattern-card"]','[class*="Card"i]','article']
            let cards = []
            for (const sel of selectors) {
              const found = document.querySelectorAll(sel)
              if (found.length > 2) { cards = Array.from(found); break }
            }
            cards.forEach(card => {
              const video = card.querySelector('video')
              const img   = card.querySelector('img')
              const { appName, appCategory } = getAppInfo(card)
              if (video) {
                const src = video.src || video.currentSrc || video.getAttribute('src') ||
                  Array.from(video.querySelectorAll('source')).map(s=>s.src).find(Boolean) || ''
                const thumb = video.poster || img?.src || ''
                if (src && !seen.has(src)) { seen.add(src); result.push({ type:'video', src, thumbnail:thumb, appName, category:'UPA', appCategory }) }
              } else if (img) {
                const src = img.src || ''
                if (!src || src.includes('logo') || src.includes('banner') || img.width < 80 || seen.has(src)) return
                seen.add(src); result.push({ type:'image', src, thumbnail:src, appName, category:'UPA', appCategory })
              }
            })
            if (!result.length) {
              document.querySelectorAll('img').forEach(img => {
                if (img.width < 80 || img.height < 80) return
                const s = img.src||''
                if (!s || s.includes('logo') || s.includes('banner') || seen.has(s)) return
                seen.add(s); result.push({ type:'image', src:s, thumbnail:s, appName:'', category:'UPA', appCategory:'' })
              })
            }
            // A방법용: 클릭 가능한 카드 img 개수 반환
            result._imgCount = document.querySelectorAll('[class*="css-1pg6uaj"] img').length
            return result
          })()
        `)

        const imgCount = items._imgCount || 0
        delete items._imgCount

        // A방법: css-1pg6uaj img 클릭 → 팝업 video src 추출
        if (imgCount > 0) {
          const videoFromClick = await w.webContents.executeJavaScript(`
            (async function() {
              const imgs = Array.from(document.querySelectorAll('[class*="css-1pg6uaj"] img')).slice(0, 8)
              const videos = []
              for (const img of imgs) {
                try {
                  img.click()
                  await new Promise(r => setTimeout(r, 1000))
                  const v = document.querySelector('video[src], [role="dialog"] video, [class*="modal"] video, [class*="overlay"] video')
                  if (v && v.src && v.src.startsWith('http')) {
                    videos.push({ src: v.src, thumbnail: img.src || '' })
                  }
                  // 팝업 닫기
                  const closeBtn = document.querySelector('[aria-label="close"], [aria-label="Close"], button[class*="close"]')
                  if (closeBtn) closeBtn.click()
                  else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
                  await new Promise(r => setTimeout(r, 400))
                } catch(e) {}
              }
              return videos
            })()
          `).catch(() => [])

          if (Array.isArray(videoFromClick)) {
            videoFromClick.forEach(v => {
              if (v.src && !items.find(i => i.src === v.src)) {
                items.push({ type:'video', src:v.src, thumbnail:v.thumbnail, appName:'', category:catName, appCategory:'' })
              }
            })
          }
        }

        // B방법 결과 병합
        videoUrls.forEach((_, url) => {
          if (!items.find(i => i.src === url)) {
            items.push({ type:'video', src:url, thumbnail:'', appName:'', category:catName, appCategory:'' })
          }
        })

        try { w.webContents.session.webRequest.onBeforeRequest(null) } catch {}
        clearTimeout(timeout)
        resolve({ cat: catName, items: Array.isArray(items) ? items : [] })
      } catch(e) {
        console.log('[UPA error]', catName, e.message)
        try { w.webContents.session.webRequest.onBeforeRequest(null) } catch {}
        clearTimeout(timeout)
        resolve({ cat: catName, items: [] })
      }
    })
  })
}


// ── 검색 ─────────────────────────────────────────────────────────────
// 앱 이름인지 판별 (완전 일치 기준)
function isAppName(word) {
  const wl = word.toLowerCase()
  // WWIT 앱 완전 일치
  if (WWIT_APPS.some(app => app.name.toLowerCase() === wl ||
    app.kw.some(k => k === wl))) return true
  // UPA 앱 완전 일치
  for (const apps of Object.values(UPA_APP_CATEGORIES)) {
    for (const name of apps) {
      if (name.toLowerCase() === wl) return true
    }
  }
  return false
}

// 앱 이름으로 검색
async function searchByAppName(word) {
  const wl = word.toLowerCase()
  const data = {}

  // WWIT 앱 매칭
  for (const app of WWIT_APPS) {
    if (app.name.toLowerCase() === wl || app.kw.some(k => k === wl)) {
      let urls = [...(urlCache.apps[app.slug] || [])]
      const seen = new Set(urls)
      Object.values(urlCache.paths).forEach(sg => {
        (sg[app.slug] || []).forEach(u => {
          const c = u.replace(/&amp;/g,'&')
          if (!seen.has(c)) { seen.add(c); urls.push(c) }
        })
      })
      if (urls.length) data[app.name] = urls.map(u => ({ type:'image', src:u, thumbnail:u, source:'wwit' }))
    }
  }

  // UPA 앱 매칭
  ucCache.forEach(uc => {
    if (uc.appName.toLowerCase() === wl && uc.images.length) {
      if (!data[uc.appName]) data[uc.appName] = []
      uc.images.forEach(img => data[uc.appName].push({
        type:'image', src:img.src, thumbnail:img.src,
        screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url
      }))
    }
  })
  return data
}


// ── 검색 개선 헬퍼 ───────────────────────────────────────────────────

// 영문 → 한글 앱명 변환 (카카오, 네이버 등 자주 쓰는 것)
const EN_TO_KO = {
  'kakao':'카카오', 'naver':'네이버', 'toss':'토스', 'baemin':'배달의민족',
  'coupang':'쿠팡', 'samsung':'삼성', 'lg':'LG', 'kakaot':'카카오T',
  'ohouse':'오늘의집', 'zigzag':'지그재그', 'kream':'크림', 'wrtn':'뤼튼',
  'chzzk':'치지직', 'planfit':'플랜핏', 'alarmy':'알라미', 'tada':'타다',
  'mmm':'mmm', 'npay':'네이버페이', 'monimo':'모니모', 'cardoc':'카닥',
}

// 초성 추출
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']
function getChosung(str) {
  return [...str].map(c => {
    const code = c.charCodeAt(0) - 0xAC00
    if (code < 0 || code > 11171) return c
    return CHO[Math.floor(code / 588)]
  }).join('')
}

// 편집 거리 (레벤슈타인) - 오타 허용
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99
  const m = a.length, n = b.length
  const dp = Array.from({length:m+1}, (_,i) => Array.from({length:n+1}, (_,j) => i||j))
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1])
  return dp[m][n]
}

// 검색어 정규화 (특수문자, 공백 정리, 영문 변환)
function normalizeQuery(kw) {
  let q = kw.toLowerCase().trim()
  q = EN_TO_KO[q] || q  // 영문 앱명 변환
  q = q.replace(/[·•·]/g, ' ').replace(/\s+/g, ' ').trim()
  return q
}

// 앱명 매칭 스코어 (정확>시작>초성>포함>오타)
function appMatchScore(query, appName) {
  const q = query.toLowerCase(), a = appName.toLowerCase()
  if (a === q) return 100
  if (a.startsWith(q) || q.startsWith(a)) return 80
  // 초성 검색은 초성만 입력했을 때만 적용 (예: "ㅋㅋㅇ"). 완성된 글자를 넣었는데
  // 초성이 같다는 이유로 다른 앱이 걸리던 문제("롯데온"→"런데이") 방지
  if (/^[ㄱ-ㅎ]{2,}$/.test(q) && getChosung(a).startsWith(q)) return 70
  if (a.includes(q) || q.includes(a)) return 60
  if (q.length >= 3 && editDistance(q, a) <= 1) return 40   // 오타 1개 허용
  if (q.length >= 4 && editDistance(q, a) <= 2) return 20   // 오타 2개 허용
  return 0
}

// ── 검색 헬퍼: slug의 WWIT URL 수집 (캐시 + paths + 실시간) ──────────
async function collectWwitUrls(slug) {
  let urls = [...(urlCache.apps[slug] || [])]
  const seen = new Set(urls)
  Object.values(urlCache.paths).forEach(sg => {
    (sg[slug] || []).forEach(u => {
      const c = u.replace(/&amp;/g,'&').replace(/&#38;/g,'&')
      if (!seen.has(c)) { seen.add(c); urls.push(c) }
    })
  })
  if (!urls.length) {
    const app = WWIT_APPS.find(a => a.slug === slug)
    if (app && app.page) {
      const html = await fetchHtml(WWIT_BASE + app.page)
      urls = wwit_parse(html, slug)[slug] || []
      if (urls.length) { urlCache.apps[slug] = urls; saveCache() }
    }
  }
  // tagsDb fallback: page URL 없거나 크롤 실패 시 tags.json 이미지 사용
  if (!urls.length && Object.keys(tagsDb).length) {
    urls = Object.keys(tagsDb).filter(u => {
      const m = u.match(/\/images\/posts\/([^/]+)\//)
      return m && m[1] === slug
    })
  }
  return urls
}

// ── 검색 헬퍼: appName의 UPA 이미지를 data에 병합 ───────────────────
function mergeUpaImages(data, appNames) {
  const nameSet = new Set(Array.isArray(appNames) ? appNames : [appNames])
  const lowerSet = new Set([...nameSet].map(n => n.toLowerCase()))
  ucCache.forEach(uc => {
    if (!uc.appName || !uc.images.length) return
    if (!nameSet.has(uc.appName) && !lowerSet.has(uc.appName.toLowerCase())) return
    if (!data[uc.appName]) data[uc.appName] = []
    uc.images.forEach(img => data[uc.appName].push({
      type:'image', src:img.src, thumbnail:img.src,
      screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url
    }))
  })
  return data
}

// ── 검색어 전체를 앱 이름으로 먼저 해석 ─────────────────────────────
// 띄어쓰기·점·대소문자를 무시하고 비교하고("v live" = "V LIVE", "l point" = "L.POINT"),
// 영문 이름을 한글 발음으로 적은 경우도 찾음("엘포인트" → "lpoint", "브이라이브" → "vlive").
// 이 단계가 없으면 "v live"는 두 단어로 쪼개져 앱을 못 찾고,
// "엘포인트"는 '포인트'라는 화면 패턴으로 먼저 걸려 앱 검색까지 가지 못함.
function normAppKey(s) { return String(s || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '') }

const KO_LATIN = [
  // 자주 쓰는 외래어 (긴 것부터 맞춰봄)
  ['포인트','point'],['라이브','live'],['페이','pay'],['뱅크','bank'],['뱅킹','banking'],['카드','card'],['마켓','market'],
  ['스토어','store'],['뮤직','music'],['클럽','club'],['패스','pass'],['플러스','plus'],['모바일','mobile'],['샵','shop'],
  ['숍','shop'],['북','book'],['티비','tv'],['홈','home'],['픽','pick'],['링크','link'],['월렛','wallet'],['머니','money'],
  ['쇼핑','shopping'],['푸드','food'],['플레이','play'],['게임','game'],['뉴스','news'],['맵','map'],['택시','taxi'],
  ['바이크','bike'],['드라이브','drive'],['클라우드','cloud'],['메일','mail'],['캘린더','calendar'],['노트','note'],
  ['워크','work'],['스타','star'],['킹','king'],['헬스','health'],['케어','care'],['핏','fit'],['데이','day'],['타임','time'],
  ['스타일','style'],['온','on'],['원','one'],['톡','talk'],['앱','app'],['웹툰','webtoon'],['멤버스','members'],
  ['멤버십','membership'],['오더','order'],['딜','deal'],['박스','box'],['라운지','lounge'],['스마트','smart'],['월드','world'],
  ['시티','city'],['에어','air'],['투어','tour'],['트립','trip'],['티켓','ticket'],['무비','movie'],['시네마','cinema'],
  ['라이프','life'],['프렌즈','friends'],['키즈','kids'],['스쿨','school'],['클래스','class'],['잡','job'],['솔','sol'],
  // 알파벳 읽는 소리
  ['더블유','w'],['에이치','h'],['에이','a'],['에프','f'],['에스','s'],['엑스','x'],['와이','y'],['제이','j'],['케이','k'],
  ['브이','v'],['아이','i'],['제트','z'],['엘','l'],['엠','m'],['엔','n'],['큐','q'],['알','r'],['비','b'],['씨','c'],
  ['디','d'],['이','e'],['지','g'],['오','o'],['피','p'],['티','t'],['유','u'],
].sort((a, b) => b[0].length - a[0].length)

// 한글로 적은 영문 이름을 알파벳으로.
// partial=false: 전부 바꿀 수 있을 때만 결과를 돌려줌 ("엘포인트" → "lpoint")
// partial=true : 바꿀 수 없는 글자는 그대로 둠 ("롯데온" → "롯데on")
function koToLatin(s, partial) {
  let out = '', i = 0, changed = false
  while (i < s.length) {
    const ch = s[i]
    if (/[0-9a-z]/.test(ch)) { out += ch; i++; continue }
    const hit = KO_LATIN.find(([ko]) => s.startsWith(ko, i))
    if (!hit) { if (!partial) return null; out += ch; i++; continue }
    out += hit[1]; i += hit[0].length; changed = true
  }
  return changed && out !== s ? out : null
}

// 검색어 전체가 가리키는 앱 찾기 → { wwit:[앱], slugs:[{slug,name}], upa:[이름] } 또는 null
function findAppsByWholeQuery(kw) {
  const nq = normAppKey(kw)
  if (nq.length < 2) return null
  const variants = [nq]
  if (/[가-힣]/.test(nq)) {
    const latin = koToLatin(nq, false), mixed = koToLatin(nq, true)
    if (latin && latin.length >= 3) variants.push(latin)
    if (mixed && mixed !== latin && mixed.length >= 3) variants.push(mixed)
  }
  const matches = name => {
    const n = normAppKey(name)
    if (!n) return 0
    for (const v of variants) {
      if (n === v) return 2                                  // 완전히 같음
      if (v.length >= 4 && n.startsWith(v)) return 1         // 앞부분이 같음 (4글자 이상일 때만)
    }
    return 0
  }
  const found = { wwit: [], slugs: [], upa: [] }
  let best = 0
  const consider = (score, add) => {
    if (!score) return
    if (score > best) { best = score; found.wwit = []; found.slugs = []; found.upa = [] }
    if (score === best) add()
  }
  WWIT_APPS.forEach(app => consider(Math.max(matches(app.name), matches(app.slug)), () => found.wwit.push(app)))
  Object.entries(slug2name).forEach(([slug, name]) => {
    if (WWIT_APPS.some(a => a.slug === slug)) return
    consider(Math.max(matches(name), matches(slug)), () => found.slugs.push({ slug, name }))
  })
  const upaNames = new Set()
  for (const apps of Object.values(UPA_APP_CATEGORIES)) for (const n of apps) upaNames.add(n)
  ucCache.forEach(uc => { if (uc && uc.appName) upaNames.add(uc.appName) })
  upaNames.forEach(n => consider(matches(n), () => { if (!found.upa.includes(n)) found.upa.push(n) }))
  if (!best) return null
  found.exact = best === 2
  return found
}

function resolveWholeAppQuery(kw) {
  const f = findAppsByWholeQuery(kw)
  if (!f) return null
  // 같은 앱이 WWIT와 UPA 양쪽에 있으면 합쳐서 보여줌
  if (f.wwit.length === 1) {
    const same = new Set(f.upa)
    const key = normAppKey(f.wwit[0].name)
    for (const apps of Object.values(UPA_APP_CATEGORIES)) for (const n of apps) if (normAppKey(n) === key) same.add(n)
    ucCache.forEach(uc => { if (uc && uc.appName && normAppKey(uc.appName) === key) same.add(uc.appName) })
    return same.size ? { type:'mixed_app', wwit:f.wwit[0], upaNames:[...same] } : { type:'wwit_app', app:f.wwit[0] }
  }
  if (f.wwit.length > 1) return { type:'wwit_multi', apps:f.wwit }
  if (f.upa.length) return { type:'upa_app', appNames:f.upa }
  if (f.slugs.length) return { type:'slug_search', slug:f.slugs[0].slug, name:f.slugs[0].name }
  return null
}

function resolveKw(kw) {
  // "#지도"처럼 #으로 시작하면 앱 이름 해석 없이 태그에서만 찾음
  const rawKw = String(kw || '').trim()
  if (rawKw.startsWith('#') && rawKw.length > 1) return { type:'screen_tag', keyword: rawKw.slice(1).trim().toLowerCase(), forced: true }

  const kl = normalizeQuery(kw)
  const words = kl.split(/\s+/).filter(Boolean)

  // 카테고리 매칭
  for (const [k, p] of Object.entries(WWIT_PATHS)) {
    if (p.startsWith('cat/') && (kl === k.toLowerCase() || kl.includes(k.toLowerCase()) || k.toLowerCase().includes(kl))) {
      const catSlugs = CATEGORY_SLUGS[k] || []
      if (k in CATEGORY_SLUGS) return { type:'cat_slugs', label:k, slugs:catSlugs }
    }
  }

  // 복합 쿼리: 첫 단어가 앱이름이면 AND, 아니면 OR
  if (words.length >= 2) {
    // 여러 단어 전체가 하나의 앱 이름인 경우 ("v live", "카카오 뱅크") → 그 앱으로
    const wholeApp = resolveWholeAppQuery(kl)
    if (wholeApp) return wholeApp

    // 앞쪽 몇 단어가 앱 이름이고 나머지가 화면 조건인 경우 ("v live 홈")
    for (let k = words.length - 1; k >= 2; k--) {
      const f = findAppsByWholeQuery(words.slice(0, k).join(' '))
      const canon = f && f.exact && ((f.wwit[0] && f.wwit[0].name) || f.upa[0] || (f.slugs[0] && f.slugs[0].name))
      if (canon) return { type:'app_and_pattern', appWord:canon.toLowerCase(), patternWords:words.slice(k) }
    }

    let appWord = words[0]
    let firstIsApp = isAppName(appWord)
    if (!firstIsApp) {
      // 목록에 없는 UPA 앱이거나 한글 발음으로 적은 경우 ("엘포인트 결제") → 등록된 이름으로 바꿔서 검색
      const f = findAppsByWholeQuery(appWord)
      const canon = f && ((f.wwit[0] && f.wwit[0].name) || f.upa[0] || (f.slugs[0] && f.slugs[0].name))
      if (canon) { firstIsApp = true; appWord = canon.toLowerCase() }
    }
    if (firstIsApp) {
      // AND: 특정 앱의 특정 화면
      return { type:'app_and_pattern', appWord, patternWords:words.slice(1) }
    } else {
      // OR: 각 단어 결과 합치기
      return { type:'multi_or', words }
    }
  }

  // 단일 단어
  const w = words[0]

  // 패턴/컴포넌트 매칭 먼저 (앱 매칭보다 우선)
  for (const [k, p] of Object.entries(WWIT_PATHS)) {
    if (!p.startsWith('cat/') && (w === k.toLowerCase() || k.toLowerCase() === w))
      return { type:'wwit_path', path:p }
  }

  // 화면 종류를 뜻하는 단어는 앱보다 화면 태그를 먼저 (이름이 정확히 그 단어인 앱이 있으면 앱 우선)
  if (SCREEN_WORDS.has(w)) {
    const sameNameApp = findAppsByWholeQuery(w)
    if (!(sameNameApp && sameNameApp.exact)) {
      // 그 태그가 붙은 화면이 충분히 있을 때만 (거의 없으면 기존 방식대로 앱·패턴에서 찾음)
      let n = 0
      for (const url in tagsDb) {
        const tags = tagsDb[url]
        if (Array.isArray(tags) && tags.some(t => { const tl = String(t).toLowerCase(); return tl === w || tl.includes(w) })) { if (++n >= 8) break }
      }
      if (n >= 8) return { type:'screen_tag', keyword: w }
    }
  }

  // WWIT 앱 매칭 (스코어 기반 - 오타/초성/영문 허용)
  const scored = WWIT_APPS.map(app => {
    const nameScore = appMatchScore(w, app.name)
    const kwScore = app.kw.reduce((best, k) => Math.max(best, appMatchScore(w, k)), 0)
    return { app, score: Math.max(nameScore, kwScore) }
  }).filter(x => x.score > 0).sort((a,b) => b.score-a.score)
  // 이름이 정확히 같은 UPA 앱이 있으면(띄어쓰기·점 무시, 한글 발음 표기 포함) 그 앱을 먼저.
  // 이전에는 오타 보정이 먼저 적용되어 "엘포인트"가 "엘리펀트"로 연결되는 식의 오류가 있었음.
  // (WWIT 앱과 정확히 같은 경우는 아래 기존 흐름이 그대로 처리)
  const exactApp = findAppsByWholeQuery(w)
  if (exactApp && exactApp.exact && !exactApp.wwit.length && exactApp.upa.length) {
    const nq = normAppKey(w)
    // 같은 이름으로 시작하는 형제 앱도 함께 ("유튜브" → 유튜브 + 유튜브 뮤직, "네이버" → 네이버 + 네이버페이)
    const upaSet = new Set(exactApp.upa)
    for (const apps of Object.values(UPA_APP_CATEGORIES)) for (const n of apps) if (normAppKey(n).startsWith(nq)) upaSet.add(n)
    ucCache.forEach(uc => { if (uc && uc.appName && normAppKey(uc.appName).startsWith(nq)) upaSet.add(uc.appName) })
    const wwitSiblings = scored.filter(x => x.score >= 80 &&
      (normAppKey(x.app.name).startsWith(nq) || x.app.kw.some(k => normAppKey(k) === nq)))
    if (wwitSiblings.length) return { type:'wwit_upa_merged', slugs:wwitSiblings.map(x => x.app.slug), upaNames:[...upaSet] }
    return { type:'upa_app', appNames:[...upaSet] }
  }
  if (exactApp && exactApp.exact && !exactApp.wwit.length) {
    const r0 = resolveWholeAppQuery(w)
    if (r0) return r0
  }
  // 확실한 일치(정확·앞부분·포함)가 있으면 오타 수준의 약한 일치는 버림
  const strongOnly = scored.length && scored[0].score >= 60 ? scored.filter(x => x.score >= 60) : scored
  const matched = strongOnly.map(x => x.app)
  if (matched.length === 1) {
    const upaAlso = new Set()
    for (const apps of Object.values(UPA_APP_CATEGORIES)) {
      for (const appName of apps) {
        if (appName.toLowerCase() === matched[0].name.toLowerCase()) upaAlso.add(appName)
      }
    }
    ucCache.forEach(uc => {
      if (uc.appName && uc.appName.toLowerCase() === matched[0].name.toLowerCase()) upaAlso.add(uc.appName)
    })
    if (upaAlso.size) return { type:'mixed_app', wwit:matched[0], upaNames:[...upaAlso] }
    return { type:'wwit_app', app:matched[0] }
  }
  if (matched.length > 1)  return { type:'wwit_multi', apps:matched }

  // 앱 이름과 정확히 일치하면(띄어쓰기·점 무시, 한글 발음 표기 포함) 아래의 느슨한 패턴·태그 매칭보다 먼저 처리.
  // 예: "엘포인트"가 '포인트' 패턴으로 잘못 걸리지 않고 L.POINT 앱으로 연결됨
  const wholeApp = resolveWholeAppQuery(w)
  if (wholeApp) return wholeApp

  // 패턴 부분 매칭
  for (const [k, p] of Object.entries(WWIT_PATHS)) {
    if (!p.startsWith('cat/') && (w.includes(k.toLowerCase()) || k.toLowerCase().includes(w)))
      return { type:'wwit_path', path:p }
  }

  // 태그 기반 컴포넌트 매칭
  for (const [compName, tagList] of Object.entries(COMPONENT_TAG_MAP)) {
    const compL = compName.toLowerCase()
    if (compL.includes(w) || w.includes(compL) ||
      tagList.some(t => t.toLowerCase().includes(w) || w.includes(t.toLowerCase())))
      return { type:'tag_search', label:compName, tags:tagList }
  }

  // UPA 앱 이름 매칭
  const upaMatchMap = new Map()
  for (const apps of Object.values(UPA_APP_CATEGORIES)) {
    for (const appName of apps) {
      const score = appMatchScore(w, appName)
      if (score > 0 && score > (upaMatchMap.get(appName)||0)) upaMatchMap.set(appName, score)
    }
  }
  ucCache.forEach(uc => {
    if (!uc.appName) return
    const score = appMatchScore(w, uc.appName)
    if (score > 0 && score > (upaMatchMap.get(uc.appName)||0)) upaMatchMap.set(uc.appName, score)
  })
  // 스코어 30 이상만 매칭 결과로 사용
  const upaMatched = new Set([...upaMatchMap.entries()].filter(([,s])=>s>=30).map(([n])=>n))
  if (upaMatched.size) {
    // CATEGORY_SLUGS에도 있으면 WWIT+UPA 통합
    const wwit_slugs = []
    for (const slugs of Object.values(CATEGORY_SLUGS)) {
      for (const slug of slugs) {
        const slugName = (slug2name[slug] || slug).toLowerCase()
        if (slugName === w || slugName.includes(w) || w.includes(slugName))
          wwit_slugs.push(slug)
      }
    }
    if (wwit_slugs.length) return { type:'wwit_upa_merged', slugs:wwit_slugs, upaNames:[...upaMatched] }
    return { type:'upa_app', appNames:[...upaMatched] }
  }

  // slug2name 기반 매칭 (EXTRA_NAMES 포함)
  for (const [slug, name] of Object.entries(slug2name)) {
    const nl = name.toLowerCase()
    if ((nl === w || nl.includes(w) || w.includes(nl)) && !WWIT_APPS.some(a => a.slug === slug)) {
      return { type:'slug_search', slug, name }
    }
  }

  // ── 전체 tagsDb 키워드 검색: 태그에 키워드가 포함된 이미지 수집 ──
  if (Object.keys(tagsDb).length) {
    return { type:'global_tag_keyword', keyword: w }
  }

  return null
}

// ── 캐시 빌드 ────────────────────────────────────────────────────────
let isBuildingCache = false

async function buildCache(splashWin) {
  if (isBuildingCache) return
  isBuildingCache = true

  const total = WWIT_APPS.length + WWIT_ALL_PATHS.length
  let done = 0
  const tick = (msg, count = 0) => {
    done++
    const pct = Math.round(done / total * 100)
    splashWin?.webContents.send('splash-progress', { done, total, pct, msg, count })
    win?.webContents.send('cache-progress', { done, total, pct, msg, count })
    console.log(`[cache] ${pct}% ${msg} (${count})`)
  }

  const BATCH = 6
  for (let i = 0; i < WWIT_APPS.length; i += BATCH) {
    await Promise.all(WWIT_APPS.slice(i, i + BATCH).map(async app => {
      if (urlCache.apps[app.slug]?.length) { tick(app.name, urlCache.apps[app.slug].length); return }
      const html   = await fetchHtml(WWIT_BASE + app.page)
      const groups = wwit_parse(html, app.slug)
      const urls   = groups[app.slug] || []
      if (urls.length) urlCache.apps[app.slug] = urls
      tick(app.name, urls.length)
    }))
  }

  for (let i = 0; i < WWIT_ALL_PATHS.length; i += BATCH) {
    await Promise.all(WWIT_ALL_PATHS.slice(i, i + BATCH).map(async p => {
      if (urlCache.paths[p] && Object.keys(urlCache.paths[p]).length) { tick(p, 0); return }
      const html   = await fetchHtml(WWIT_BASE + p)
      const groups = wwit_parse(html)
      if (Object.keys(groups).length) urlCache.paths[p] = groups
      else if (p === 'pattern/home') {
        // 홈화면 파싱 실패 시 재시도
        console.log('[home] retry...')
        const html2 = await fetchHtml(WWIT_BASE + p)
        const groups2 = wwit_parse(html2)
        if (Object.keys(groups2).length) urlCache.paths[p] = groups2
      }
      tick(p, Object.keys(groups).length)
    }))
  }

  urlCache.updated = Date.now()
  saveCache()
  isBuildingCache = false

  const appCount = Object.keys(urlCache.apps).length
  splashWin?.webContents.send('splash-done', { appCount })
  win?.webContents.send('cache-done', { appCount })
  console.log('[cache] done:', appCount, 'apps')

  // 홈화면 패턴 자동 보장
  await ensureHomePattern()
}

// ── 창 ───────────────────────────────────────────────────────────────
let win = null

function createMainWindow() {
  win = new BrowserWindow({
    width: 1380, height: 860, minWidth: 960, minHeight: 600,
    title: 'Bucci',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#F5F6FA', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webSecurity: false,
    }
  })
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, 'index.html'))

  // wwit.design 이미지 Referer 헤더 추가 (썸네일 403 우회)
  win.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ['https://wwit.design/*', 'https://*.wouldyoutest.com/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }
      if (details.url.includes('wwit.design')) {
        headers['Referer'] = 'https://wwit.design/'
        headers['Origin'] = 'https://wwit.design'
      }
      callback({ requestHeaders: headers })
    }
  )

  // Ctrl+C → 렌더러로 전달
  win.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.key.toLowerCase() === 'c' && input.type === 'keyDown') {
      win.webContents.send('ctrl-c-pressed')
      // 기본 동작 막지 않음 (텍스트 복사는 그대로 작동)
    }
  })

  return win
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 480, height: 300, frame: false, resizable: false, alwaysOnTop: true,
    backgroundColor: '#0D1B40',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  splash.loadFile(path.join(__dirname, 'splash.html'))
  return splash
}

// Electron userData 경로 분리 - 우리 캐시 파일 보호
// Electron이 Buchji 루트 폴더를 초기화하지 않도록
app.setPath('userData', path.join(os.homedir(), 'AppData', 'Roaming', 'Bucci', 'electron'))

// asset:// 프로토콜 등록은 app ready 이후 첫 번째 whenReady에서
app.whenReady().then(async () => {
  // asset:// 프로토콜 등록 (공공포털 로컬 이미지)
  try {
    const { protocol } = require('electron')
    protocol.registerFileProtocol('asset', (request, callback) => {
      const filePath = decodeURIComponent(request.url.slice('asset://'.length))
      callback({ path: path.join(__dirname, 'assets', filePath) })
    })
    console.log('[asset] protocol registered')
  } catch(e) { console.log('[asset] protocol error:', e.message) }
  loadTags()
  const wwit_cached = loadCache()
  const uc_cached   = loadUcCache()

  if (wwit_cached && uc_cached) {
    // 둘 다 캐시 있으면 바로 실행
    await ensureHomePattern()  // 홈화면 패턴 보장
    createMainWindow()
    win.once('ready-to-show', () => {
      win.show()
      win.webContents.send('cache-loaded', { appCount: Object.keys(urlCache.apps).length })
      win.webContents.send('uc-loaded', { count: ucCache.length })
    })
  } else {
    // 캐시 없으면 스플래시 띄우고 수집
    const splash = createSplashWindow()
    createMainWindow()
    splash.once('ready-to-show', () => splash.show())

    if (!wwit_cached) {
      // WWIT + UC 순차 수집
      await buildCache(splash)
    }
    if (!uc_cached) {
      splash.webContents.send('splash-phase', { phase: 'uc' })
      await buildUseCaseCache(splash)
    }

    win.once('ready-to-show', () => {
      win.show()
      win.webContents.send('cache-loaded', { appCount: Object.keys(urlCache.apps).length })
      win.webContents.send('uc-loaded', { count: ucCache.length })
      splash.destroy()
    })
    win.loadFile(path.join(__dirname, 'index.html'))
  }
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// 화면에서 쓰는 버전 조회 / 수동 업데이트 확인
ipcMain.handle('get-version', () => {
  try { return require('./updater').info() } catch { return { version: '', dev: false } }
})
ipcMain.handle('check-update', async () => {
  try { return await require('./updater').manual({ app, dialog, getWindow: () => win }) }
  catch (e) { return { status: 'offline', error: String(e && e.message || e) } }
})

// 자동 업데이트: 창이 뜨고 잠시 뒤 새 버전 확인 (실패해도 앱 동작에는 영향 없음)
app.whenReady().then(() => {
  setTimeout(() => {
    try { require('./updater').start({ app, dialog, getWindow: () => win }) } catch (e) { console.log('[update] skip:', e.message) }
  }, 8000)
})

// Ctrl+C를 before-input-event로 렌더러에 전달
// createMainWindow 후 직접 등록 (browser-window-focus 보다 안정적)

// ── IPC ──────────────────────────────────────────────────────────────

ipcMain.handle('search', async (_, kw) => {
  const res = await searchCore(kw)
  try { if (res && !res.meta) res.meta = describeSearch(kw, res) } catch {}
  // 결과가 없으면 "~로 찾았어요" 설명은 붙이지 않음 (다시 찾는 버튼이 있는 경우만 남김)
  try { if (res && res.meta && !Object.keys(res.data || {}).length && !res.meta.alt) res.meta = null } catch {}
  return res
})

// 화면 종류를 뜻하는 일반 단어. 이런 단어는 앱보다 화면 태그를 먼저 찾음
// (예: "지도" → '네이버 지도' 앱이 아니라 지도가 있는 화면들, "송금" → 토스 앱이 아니라 송금 화면들)
const SCREEN_WORDS = new Set(['지도','송금','이체','결제','채팅','로그인','회원가입','검색','필터','장바구니','주문','알림','설정',
  '마이페이지','프로필','리뷰','후기','온보딩','스플래시','인증','약관','쿠폰','포인트','적립','혜택','멤버십','통계','차트','그래프',
  '캘린더','달력','피드','상세','목록','리스트','카드','탭바','바텀시트','팝업','모달','토글','체크박스','드롭다운','버튼','입력폼',
  '로딩','에러','오류','빈상태','완료','성공','예약','배송','공유','업로드','추천','랭킹','배너','이벤트','공지','영상','플레이어',
  '카메라','권한','비밀번호','자산','잔액','투자','주식','대출','보험','충전','환불','취소','픽업','탈퇴','문의','상담','고객센터',
  '다크모드','라이트모드','일정','댓글'])

// 그 단어와 이름·키워드가 겹치는 앱 (태그 결과 아래 "관련 앱"으로 안내)
function relatedAppsFor(w) {
  const nq = normAppKey(w)
  const names = []
  const add = n => { if (n && !names.includes(n)) names.push(n) }
  WWIT_APPS.forEach(app => {
    if (normAppKey(app.name).includes(nq) || app.kw.some(k => normAppKey(k) === nq)) add(app.name)
  })
  for (const apps of Object.values(UPA_APP_CATEGORIES)) for (const n of apps) if (normAppKey(n).includes(nq)) add(n)
  ucCache.forEach(uc => { if (uc && uc.appName && normAppKey(uc.appName).includes(nq)) add(uc.appName) })
  return names.slice(0, 6)
}

// 검색어를 어떻게 해석했는지 사용자에게 보여줄 설명
//   text: 한 줄 설명 / apps: 눌러서 이동할 관련 앱 / alt: 다른 방식으로 다시 찾는 버튼 {label, kw}
function describeSearch(kw, res) {
  const r = resolveKw(kw)
  if (!r) return null
  const shown = String(kw).trim()
  const nq = normAppKey(shown)
  const tagAlt = { label: `'${shown}' 태그로 찾기`, kw: '#' + shown }
  const sameName = names => names.some(n => normAppKey(n) === nq || (findAppsByWholeQuery(shown) || {}).exact)
  const appMeta = names => {
    names = names.filter(Boolean)
    if (!names.length) return null
    const list = names.slice(0, 4).map(n => `'${n}'`).join(', ') + (names.length > 4 ? ` 외 ${names.length - 4}개` : '')
    if (sameName(names)) return { text: `${list} 앱 화면이에요.` }
    return { text: `'${shown}'에 가장 가까운 앱 ${list}의 화면이에요.`, alt: tagAlt }
  }
  switch (r.type) {
    case 'screen_tag':
      return r.forced
        ? { text: `'${r.keyword}' 태그가 붙은 화면이에요.` }
        : { text: `'${r.keyword}' 화면을 태그로 찾았어요.`, apps: relatedAppsFor(r.keyword) }
    case 'wwit_app':        return appMeta([r.app.name])
    case 'mixed_app':       return appMeta([r.wwit.name])
    case 'wwit_multi':      return appMeta(r.apps.map(a => a.name))
    case 'upa_app':         return appMeta(r.appNames)
    case 'slug_search':     return appMeta([r.name])
    case 'wwit_upa_merged': return appMeta([...r.upaNames, ...r.slugs.map(s => slug2name[s] || s)])
    case 'app_and_pattern': return { text: `'${r.appWord}' 앱에서 '${r.patternWords.join(' ')}' 화면을 찾았어요.` }
    case 'cat_slugs':       return { text: `'${r.label}' 분야의 앱이에요.` }
    case 'wwit_path':       return { text: `'${shown}' 화면 패턴으로 찾았어요.` }
    case 'tag_search':      return { text: `'${r.label}' 컴포넌트가 있는 화면이에요.`, alt: normAppKey(r.label) === nq ? null : tagAlt }
    case 'multi_or':        return { text: `'${r.words.join("', '")}' 중 하나라도 맞는 화면이에요. 모두 맞는 화면은 아직 없어요.` }
    case 'global_tag_keyword': return { text: `'${r.keyword}' 태그로 찾았어요.` }
  }
  return null
}

// 여러 단어가 모두 태그로 붙은 화면 찾기. 하나도 없으면 null (호출한 쪽에서 OR 검색으로 넘어감)
function multiWordAndSearch(words) {
  const wordsL = words.map(w => String(w).toLowerCase())
  const andData = {}
  let upaMeta = {}
  try { upaMeta = upaAppMeta() } catch {}
  Object.entries(tagsDb).forEach(([url, tags]) => {
    if (!Array.isArray(tags) || !url.startsWith('http')) return
    const tagStrs = tags.map(t => String(t).toLowerCase())
    if (!wordsL.every(w => tagStrs.some(t => t === w || (w.length >= 2 && t.includes(w))))) return
    const m = url.match(/\/images\/posts\/([^/]+)\//)
    const appName = m ? (slug2name[m[1]] || m[1]) : ((upaMeta[url] || [])[0] || '기타 레퍼런스')
    if (!andData[appName]) andData[appName] = []
    andData[appName].push({ type:'image', src:url, thumbnail:url, source: m ? 'wwit' : 'upa', tags })
  })
  if (!Object.keys(andData).length) return null
  return { data: filterVideoItems(andData), source:'mixed', meta: { text: `'${words.join("' + '")}' 조건이 모두 맞는 화면이에요.` } }
}

async function searchCore(kw) {
  const _searchKw = kw
  const r = resolveKw(kw)

  // 화면 종류 단어 / "#단어": 태그가 붙은 화면을 직접 찾음 (WWIT + UPA 모두)
  if (r?.type === 'screen_tag') {
    const kl = r.keyword.toLowerCase()
    const data = {}
    let upaMeta = {}
    try { upaMeta = upaAppMeta() } catch {}
    Object.entries(tagsDb).forEach(([url, tags]) => {
      if (!Array.isArray(tags) || !url.startsWith('http')) return
      if (!tags.some(t => { const tl = String(t).toLowerCase(); return tl === kl || (kl.length >= 2 && tl.includes(kl)) })) return
      const m = url.match(/\/images\/posts\/([^/]+)\//)
      const appName = m ? (slug2name[m[1]] || m[1]) : ((upaMeta[url] || [])[0] || '기타 레퍼런스')
      if (!data[appName]) data[appName] = []
      data[appName].push({ type:'image', src:url, thumbnail:url, source: m ? 'wwit' : 'upa', tags })
    })
    // UPA: 화면 묶음 제목에 그 단어가 있는 경우도 포함
    ucCache.forEach(uc => {
      if (!uc.appName || !uc.images.length) return
      if (!String(uc.title || '').toLowerCase().includes(kl)) return
      if (!data[uc.appName]) data[uc.appName] = []
      const have = new Set(data[uc.appName].map(i => i.src))
      uc.images.forEach(img => { if (!have.has(img.src)) data[uc.appName].push({
        type:'image', src:img.src, thumbnail:img.src, screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url }) })
    })
    return { data: sortDataByRelevance(filterVideoItems(data), r.keyword), source:'mixed' }
  }

  // AND 검색: 앱 + 패턴 (예: "토스 홈화면")
  if (r?.type === 'app_and_pattern') {
    const appData = await searchByAppName(r.appWord)
    if (!Object.keys(appData).length) return { data: {} }

    // 패턴 단어들로 필터
    const patternWords = r.patternWords.map(w => w.toLowerCase())
    const data = {}
    Object.entries(appData).forEach(([appName, items]) => {
      const filtered = items.filter(item => {
        const haystack = [
          item.screenName || '',
          item.ucTitle || '',
          item.src || ''
        ].join(' ').toLowerCase()
        return patternWords.every(pw => haystack.includes(pw))
      })
      // 태그도 체크 (WWIT)
      const tagFiltered = items.filter(item => {
        const imgTags = (tagsDb[item.src] || []).map(t => t.toLowerCase())
        return patternWords.every(pw =>
          imgTags.some(t => t.includes(pw) || pw.includes(t))
        )
      })
      // 합집합
      const combined = [...new Set([...filtered, ...tagFiltered].map(i => i.src))]
        .map(src => items.find(i => i.src === src)).filter(Boolean)
      if (combined.length) data[appName] = combined
    })
    return { data: filterVideoItems(data), source:'mixed' }
  }

  // 여러 단어 검색: 모든 단어가 태그로 붙은 화면이 있으면 그것만 (AND 우선)
  if (r?.type === 'multi_or') {
    const andRes = multiWordAndSearch(r.words)
    if (andRes) return andRes
  }

  // OR 검색: 여러 키워드 각각 검색 후 합치기
  if (r?.type === 'multi_or') {
    const data = {}
    await Promise.all(r.words.map(async w => {
      const sub = resolveKw(w)
      if (sub && sub.type === 'screen_tag') {
        // 화면 종류 단어: 그 태그가 붙은 화면
        const kl = sub.keyword.toLowerCase()
        let upaMeta = {}
        try { upaMeta = upaAppMeta() } catch {}
        Object.entries(tagsDb).forEach(([url, imgTags]) => {
          if (!Array.isArray(imgTags) || !url.startsWith('http')) return
          if (!imgTags.some(t => { const tl = String(t).toLowerCase(); return tl === kl || (kl.length >= 2 && tl.includes(kl)) })) return
          const sm = url.match(/\/images\/posts\/([^\/]+)\//)
          const appName = sm ? (slug2name[sm[1]] || sm[1]) : ((upaMeta[url] || [])[0] || '기타 레퍼런스')
          if (!data[appName]) data[appName] = []
          data[appName].push({ type:'image', src:url, thumbnail:url, source: sm ? 'wwit' : 'upa', tags:imgTags })
        })
        return
      }
      if (!sub) {
        // UPA 직접 검색
        const wl = w.toLowerCase()
        ucCache.forEach(uc => {
          if (!uc.appName || !uc.images.length) return
          if (uc.appName.toLowerCase().includes(wl) || uc.title.toLowerCase().includes(wl)) {
            if (!data[uc.appName]) data[uc.appName] = []
            uc.images.forEach(img => data[uc.appName].push({
              type:'image', src:img.src, thumbnail:img.src,
              screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url
            }))
          }
        })
        return
      }
      if (sub.type === 'wwit_app') {
        const appData = await searchByAppName(sub.app.name.toLowerCase())
        Object.entries(appData).forEach(([k,v]) => { if (!data[k]) data[k]=[]; data[k].push(...v) })
      }
      if (sub.type === 'tag_search') {
        const targetTags = new Set(sub.tags)
        Object.entries(tagsDb).forEach(([url, imgTags]) => {
          if (!Array.isArray(imgTags) || !url.startsWith('http')) return
          if (!imgTags.some(t => targetTags.has(t))) return
          const slugMatch = url.match(/\/images\/posts\/([^\/]+)\//)
          if (!slugMatch) return
          const appName = slug2name[slugMatch[1]] || slugMatch[1]
          if (!data[appName]) data[appName] = []
          data[appName].push({ type:'image', src:url, thumbnail:url, source:'wwit', tags:imgTags })
        })
      }
    }))
    return { data: filterVideoItems(data), source:'mixed' }
  }

  // 태그 기반 컴포넌트 검색 (tags.json - 키가 전체 URL)
  if (r?.type === 'tag_search') {
    const data = {}
    const targetTags = new Set(r.tags)
    Object.entries(tagsDb).forEach(([url, imgTags]) => {
      if (!Array.isArray(imgTags)) return
      if (!imgTags.some(t => targetTags.has(t))) return
      if (!url.startsWith('http')) return
      // URL에서 slug 추출: https://wwit.design//images/posts/SLUG/...
      const slugMatch = url.match(/\/images\/posts\/([^\/]+)\//)
      if (!slugMatch) return
      const slug = slugMatch[1]
      const appName = slug2name[slug] || slug
      if (!data[appName]) data[appName] = []
      data[appName].push({ type:'image', src:url, thumbnail:url, source:'wwit', tags:imgTags })
    })
    return { data: filterVideoItems(data), source:'tags' }
  }

  // 새 카테고리(cat/*): WWIT slug + UPA 키워드 기반 혼합 수집
  if (r?.type === 'cat_slugs') {
    const data = {}

    // WWIT 수집
    await Promise.all(r.slugs.map(async slug => {
      let urls = [...(urlCache.apps[slug] || [])]
      const seen = new Set(urls)
      Object.values(urlCache.paths).forEach(sg => {
        (sg[slug] || []).forEach(u => {
          const clean = u.replace(/&amp;/g,'&')
          if (!seen.has(clean)) { seen.add(clean); urls.push(clean) }
        })
      })
      if (!urls.length) {
        const app = WWIT_APPS.find(a => a.slug === slug)
        if (app) {
          const html = await fetchHtml(WWIT_BASE + app.page)
          const g = wwit_parse(html, slug)
          urls = g[slug] || []
          if (urls.length) { urlCache.apps[slug] = urls; saveCache() }
        }
      }
      if (urls.length) {
        const name = slug2name[slug] || slug
        data[name] = urls.map(u => ({ type:'image', src:u, thumbnail:u, source:'wwit' }))
      }
    }))

    // UPA 수집: 앱이름 직접 매핑
    const ucAppSet = UPA_APP_CATEGORIES[r.label] || new Set()
    ucCache.forEach(uc => {
      if (!uc.appName || !uc.images.length) return
      // 1) WWIT slug 매칭
      const slugMatch = r.slugs.some(s => (slug2name[s]||s) === uc.appName)
      // 2) 카테고리 직접 매핑
      const catMatch = ucAppSet.has(uc.appName)
      if (!slugMatch && !catMatch) return

      if (!data[uc.appName]) data[uc.appName] = []
      uc.images.forEach(img => {
        data[uc.appName].push({
          type:'image', src:img.src, thumbnail:img.src,
          screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url
        })
      })
    })

    return { data: filterVideoItems(data), source:'mixed' }
  }

  if (!r) {
    // use-case 검색도 시도
    const kl = kw.toLowerCase()
    const words = kl.split(/\s+/).filter(Boolean)
    const ucMatched = ucCache.filter(uc => {
      const name = uc.appName.toLowerCase()
      const title = uc.title.toLowerCase()
      const ind = (uc.industry||'').toLowerCase()
      return words.every(w => name.includes(w) || title.includes(w) || ind.includes(w))
    })
    if (ucMatched.length) {
      const data = {}
      ucMatched.forEach(uc => {
        const key = uc.appName || 'UPA'
        if (!data[key]) data[key] = []
        uc.images.forEach(img => data[key].push({ type:'image', src:img.src, thumbnail:img.src, screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url }))
      })
      return { data: filterVideoItems(data), source:'upa' }
    }
    // UPA에서도 검색 시도
    const klFb = kw.toLowerCase()
    const ucFb = ucCache.filter(uc =>
      uc.appName && (uc.appName.toLowerCase().includes(klFb) || klFb.includes(uc.appName.toLowerCase()))
    )
    if (ucFb.length) {
      const data = {}
      ucFb.forEach(uc => {
        if (!data[uc.appName]) data[uc.appName] = []
        uc.images.forEach(img => data[uc.appName].push({
          type:'image', src:img.src, thumbnail:img.src,
          screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url
        }))
      })
      return { data: filterVideoItems(data), source:'upa' }
    }
    return { data: {} }
  }

  if (r.type === 'wwit_app') {
    const app = r.app
    // 1. collectWwitUrls로 캐시 + paths + 실시간 fetch
    let urls = await collectWwitUrls(app.slug)
    // 2. 그래도 없으면 tagsDb에서 fallback
    if (!urls.length && Object.keys(tagsDb).length) {
      urls = Object.keys(tagsDb).filter(u => u.includes('/posts/' + app.slug + '/') || u.includes('/' + app.slug + '/'))
    }
    const data = {}
    if (urls.length) data[app.name] = urls.map(u => ({ type:'image', src:u, thumbnail:u, source:'wwit' }))
    // UPA도 병합
    mergeUpaImages(data, app.name)
    return { data: sortDataByRelevance(filterVideoItems(data), _searchKw), source:'mixed' }
  }

  if (r.type === 'wwit_multi') {
    const data = {}
    await Promise.all(r.apps.map(async app => {
      let urls = await collectWwitUrls(app.slug)
      if (!urls.length && Object.keys(tagsDb).length) {
        urls = Object.keys(tagsDb).filter(u => u.includes('/posts/' + app.slug + '/') || u.includes('/' + app.slug + '/'))
      }
      if (urls.length) data[app.name] = urls.map(u => ({ type:'image', src:u, thumbnail:u, source:'wwit' }))
      mergeUpaImages(data, app.name)
    }))
    saveCache()
    return { data: sortDataByRelevance(filterVideoItems(data), _searchKw), source:'mixed' }
  }
  if (r.type === 'wwit_path') {
    // 홈화면은 tagsDb 기반으로 처리 (WWIT pattern/home 403)
    if (r.path === 'pattern/home') {
      const data = {}

      // tagsDb에서 '홈' 태그 이미지 수집
      Object.entries(tagsDb).forEach(([url, imgTags]) => {
        if (!Array.isArray(imgTags) || !url.startsWith('http')) return
        if (!imgTags.includes('홈')) return
        const slugMatch = url.match(/\/+images\/posts\/([^\/]+)\//)
        if (!slugMatch) return
        const appName = slug2name[slugMatch[1]] || slugMatch[1]
        if (!data[appName]) data[appName] = []
        if (!data[appName].find(i => i.src === url))
          data[appName].push({ type:'image', src:url, thumbnail:url, source:'wwit' })
      })

      // UPA 홈 관련 use-case 병합
      ucCache.forEach(uc => {
        if (!uc.appName || !uc.images.length) return
        const titleL = uc.title.toLowerCase()
        if (!titleL.includes('홈') && !titleL.includes('home') && !titleL.includes('메인')) return
        if (!data[uc.appName]) data[uc.appName] = []
        uc.images.forEach(img => {
          if (!data[uc.appName].find(i => i.src === img.src))
            data[uc.appName].push({ type:'image', src:img.src, thumbnail:img.src,
              screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url })
        })
      })

      console.log('[home] result:', Object.keys(data).length, 'apps')
      return { data: filterVideoItems(data), source:'mixed' }
    }

    let groups = urlCache.paths[r.path]
    if (!groups || !Object.keys(groups).length) {
      const html = await fetchHtml(WWIT_BASE + r.path)
      groups = wwit_parse(html)
      if (Object.keys(groups).length) { urlCache.paths[r.path] = groups; saveCache() }
    }
    const data = {}
    Object.entries(groups || {}).forEach(([s, urls]) => {
      if (urls.length) data[slug2name[s] || s] = urls.map(u => ({ type:'image', src:u.replace(/&amp;/g,'&'), thumbnail:u.replace(/&amp;/g,'&'), source:'wwit' }))
    })

    // 홈화면 패턴: tags.json '홈' 태그 기반 수집
    if (r.path === 'pattern/home') {
      // 1. tags.json에서 '홈' 태그 이미지 수집 (이중 슬래시 처리)
      Object.entries(tagsDb).forEach(([url, imgTags]) => {
        if (!Array.isArray(imgTags) || !url.startsWith('http')) return
        if (!imgTags.includes('홈')) return
        const slugMatch = url.match(/\/+images\/posts\/([^\/]+)\//)
        if (!slugMatch) return
        const appName = slug2name[slugMatch[1]] || slugMatch[1]
        if (!data[appName]) data[appName] = []
        if (!data[appName].find(i => i.src === url))
          data[appName].push({ type:'image', src:url, thumbnail:url, source:'wwit', tags:imgTags })
      })

      // 2. paths 캐시 병합
      await ensureHomePattern()
      const groups2 = urlCache.paths['pattern/home'] || {}
      Object.entries(groups2).forEach(([s, urls]) => {
        const name = slug2name[s] || s
        if (!data[name]) data[name] = []
        urls.forEach(u => {
          const clean = u.replace(/&amp;/g,'&')
          if (!data[name].find(i => i.src === clean))
            data[name].push({ type:'image', src:clean, thumbnail:clean, source:'wwit' })
        })
      })
    }

    // 모든 화면 패턴에 UPA 병합 (WWIT+UPA 통합 목표)
    const patternKeywords = {
      'pattern/splash':  ['스플래시','splash','인트로','로딩화면'],
      'pattern/signin':  ['로그인','login','signin','회원가입','signup'],
      'pattern/onboarding': ['온보딩','onboarding','튜토리얼'],
      'pattern/home':    ['홈','home','메인','main'],
      'pattern/search':  ['검색','search','필터','filter'],
      'pattern/notification': ['알림','notification','푸시'],
      'pattern/order':   ['주문','결제','payment','order'],
      'pattern/mypage':  ['마이페이지','mypage','프로필','profile'],
      'pattern/setting': ['설정','setting','환경설정'],
      'pattern/review':  ['리뷰','review','후기','평점'],
      'pattern/loading': ['로딩','loading','스켈레톤'],
      'pattern/success': ['성공','완료','success','complete'],
      'pattern/cart':    ['장바구니','cart','담기'],
      'pattern/list':    ['리스트','list','목록'],
      'pattern/password':['비밀번호','password','핀번호'],
    }
    const keywords = patternKeywords[r.path] || []
    if (keywords.length) {
      ucCache.forEach(uc => {
        if (!uc.appName || !uc.images.length) return
        const haystack = (uc.title + ' ' + (uc.industry||'')).toLowerCase()
        if (!keywords.some(k => haystack.includes(k))) return
        if (!data[uc.appName]) data[uc.appName] = []
        uc.images.forEach(img => {
          if (!data[uc.appName].find(i => i.src === img.src))
            data[uc.appName].push({
              type:'image', src:img.src, thumbnail:img.src,
              screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url
            })
        })
      })
    }

    return { data: filterVideoItems(data), source:'mixed' }
  }

  // ── mixed_app: WWIT+UPA 동시 있는 앱 ──
  if (r.type === 'mixed_app') {
    // WWIT_APPS + UPA 동시 존재 앱 통합
    const app = r.wwit
    const urls = await collectWwitUrls(app.slug)
    const data = {}
    if (urls.length) data[app.name] = urls.map(u => ({type:'image',src:u,thumbnail:u,source:'wwit'}))
    mergeUpaImages(data, r.upaNames)
    return { data: sortDataByRelevance(filterVideoItems(data), _searchKw), source:'mixed' }
  }

  // ── wwit_upa_merged: CATEGORY_SLUGS+UPA 통합 ──
  if (r.type === 'wwit_upa_merged') {
    // CATEGORY_SLUGS + UPA 동시 존재 앱 통합
    const data = {}
    await Promise.all(r.slugs.map(async slug => {
      const urls = await collectWwitUrls(slug)
      if (urls.length) {
        const name = slug2name[slug] || slug
        if (!data[name]) data[name] = []
        urls.forEach(u => data[name].push({type:'image',src:u,thumbnail:u,source:'wwit'}))
      }
    }))
    mergeUpaImages(data, r.upaNames)
    return { data: sortDataByRelevance(filterVideoItems(data), _searchKw), source:'mixed' }
  }

  // ── upa_app: UPA에만 있는 앱 ──
  if (r.type === 'upa_app') {
    const data = {}
    r.appNames.forEach(appName => {
      // 대소문자/공백 무시 매칭으로 강화
      const nl = appName.toLowerCase()
      const found = ucCache.filter(uc => uc.appName && uc.images.length &&
        (uc.appName === appName || uc.appName.toLowerCase() === nl))
      if (found.length) {
        const realName = found[0].appName  // ucCache의 실제 이름 사용
        if (!data[realName]) data[realName] = []
        found.forEach(uc => uc.images.forEach(img => data[realName].push({
          type:'image', src:img.src, thumbnail:img.src,
          screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url
        })))
      }
    })
    return { data: sortDataByRelevance(filterVideoItems(data), _searchKw), source:'upa' }
  }

  // ── slug_search: EXTRA_NAMES 기반 ──
  if (r.type === 'slug_search') {
    // EXTRA_NAMES 기반 slug 검색
    const { slug, name } = r
    let urls = await collectWwitUrls(slug)
    // tagsDb fallback
    if (!urls.length && Object.keys(tagsDb).length) {
      urls = Object.keys(tagsDb).filter(u => u.includes('/' + slug + '/'))
    }
    const data = {}
    if (urls.length) data[name] = urls.map(u => ({type:'image',src:u,thumbnail:u,source:'wwit'}))
    mergeUpaImages(data, name)
    return { data: sortDataByRelevance(filterVideoItems(data), _searchKw), source:'mixed' }
  }

  // ── global_tag_keyword: 전체 tagsDb + UPA ucCache에서 키워드 검색 ──
  if (r?.type === 'global_tag_keyword') {
    const kl = r.keyword.toLowerCase()
    const data = {}

    // WWIT tagsDb: 태그에 키워드가 포함된 이미지 수집 (앱별 그룹화)
    Object.entries(tagsDb).forEach(([url, tags]) => {
      if (!Array.isArray(tags)) return
      const tagMatch = tags.some(t => t.toLowerCase().includes(kl) || kl.includes(t.toLowerCase()))
      if (!tagMatch) return
      const m = url.match(/\/images\/posts\/([^/]+)\//)
      if (!m) return
      const slug = m[1]
      const appName = slug2name[slug] || slug
      if (!data[appName]) data[appName] = []
      data[appName].push({ type:'image', src:url, thumbnail:url, source:'wwit', tags })
    })

    // UPA ucCache: 제목/태그에 키워드 포함
    ucCache.forEach(uc => {
      if (!uc.appName || !uc.images.length) return
      const haystack = (uc.title + ' ' + (uc.industry||'')).toLowerCase()
      if (!haystack.includes(kl)) return
      if (!data[uc.appName]) data[uc.appName] = []
      uc.images.forEach(img => data[uc.appName].push({
        type:'image', src:img.src, thumbnail:img.src,
        screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url
      }))
    })

    return { data: sortDataByRelevance(filterVideoItems(data), _searchKw), source:'mixed' }
  }

  return { data: {} }
}

// slug 직접 검색 (apps + paths 모두 검색)
ipcMain.handle('search-by-slug', async (_, slug) => {
  // 앱 카드/뱃지 클릭: WWIT + UPA 통합 (search IPC와 동일 결과 보장)
  const appName = slug2name[slug] || slug
  const urls = await collectWwitUrls(slug)

  // tagsDb fallback (WWIT_APPS에 없는 slug)
  let finalUrls = urls
  if (!finalUrls.length && Object.keys(tagsDb).length) {
    finalUrls = Object.keys(tagsDb).filter(u => u.includes('/posts/' + slug + '/'))
  }

  const data = {}
  if (finalUrls.length) data[appName] = finalUrls.map(u => ({ type:'image', src:u, thumbnail:u, source:'wwit' }))
  mergeUpaImages(data, appName)

  return { data: sortDataByRelevance(filterVideoItems(data), appName), source: Object.keys(data).length ? 'mixed' : 'none' }
})
ipcMain.handle('search-uc-app', async (_, appName) => {
  // UPA use-case
  const items = ucCache.filter(uc => uc.appName === appName)
  const images = []
  items.forEach(uc => {
    uc.images.forEach(img => images.push({ type:'image', src:img.src, thumbnail:img.src, screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url }))
  })
  return { data: images.length ? { [appName]: images } : {} }
})

// 앱 배지 클릭: WWIT + UPA 혼합 반환
ipcMain.handle('search-app-mixed', async (_, slug, appName) => {
  // WWIT 수집
  let urls = [...(urlCache.apps[slug] || [])]
  const seen = new Set(urls)
  Object.values(urlCache.paths).forEach(sg => {
    (sg[slug] || []).forEach(u => {
      const clean = u.replace(/&amp;/g,'&')
      if (!seen.has(clean)) { seen.add(clean); urls.push(clean) }
    })
  })
  if (!urls.length) {
    const app = WWIT_APPS.find(a => a.slug === slug)
    if (app) {
      const html = await fetchHtml(WWIT_BASE + app.page)
      const g    = wwit_parse(html, slug)
      urls = g[slug] || []
      if (urls.length) { urlCache.apps[slug] = urls; saveCache() }
    }
  }

  const data = {}
  if (urls.length) {
    data[appName] = urls.map(u => ({ type:'image', src:u, thumbnail:u, source:'wwit' }))
  }

  // UPA 매칭 (같은 앱 이름)
  const ucItems = ucCache.filter(uc => uc.appName === appName || (slug2name[slug] && uc.appName === slug2name[slug]))
  ucItems.forEach(uc => {
    uc.images.forEach(img => {
      if (!data[appName]) data[appName] = []
      data[appName].push({ type:'image', src:img.src, thumbnail:img.src, screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url })
    })
  })

  return { data: filterVideoItems(data) }
})

// 앱 목록
ipcMain.handle('get-app-list', () => {
  // WWIT_APPS 기본 목록
  const wwit = WWIT_APPS.map(a => ({ slug:a.slug, name:a.name, source:'wwit' }))
  const wwit_slugs = new Set(WWIT_APPS.map(a => a.slug))

  // paths 캐시에서 누락된 앱 모두 추가
  Object.values(urlCache.paths).forEach(slugGroups => {
    Object.keys(slugGroups).forEach(s => {
      if (!wwit_slugs.has(s)) {
        const name = slug2name[s]
        // 숫자만, 날짜형, slug 그대로인 이름 모두 필터
        const isNumOnly = /^\d+$/.test(name)
        const isDateLike = /^\d{4}-\d{2}-\d{2}$/.test(name)
        const isSlugAsName = /^[a-z0-9_-]+$/.test(name) && name === s
        if (name && !isNumOnly && !isDateLike && !isSlugAsName) {
          wwit.push({ slug:s, name, source:'wwit' })
          wwit_slugs.add(s)
        }
      }
    })
  })

  // use-case 앱별 그룹화
  const ucApps = {}
  ucCache.forEach(uc => {
    if (!uc.appName) return
    const validImgs = uc.images.filter(i => i.src && !i.src.includes('.mp4') && !i.src.includes('.mov') && !i.src.includes('.webm'))
    if (!ucApps[uc.appName]) ucApps[uc.appName] = { name:uc.appName, industry:uc.industry, count:0, thumb:'' }
    ucApps[uc.appName].count += validImgs.length
    if (!ucApps[uc.appName].thumb && validImgs.length) ucApps[uc.appName].thumb = validImgs[0].src
  })
  // 유효 이미지 없는 앱 제거
  Object.keys(ucApps).forEach(k => { if (ucApps[k].count === 0) delete ucApps[k] })
  const upa = Object.values(ucApps).map(a => ({ slug:'uc_'+a.name, name:a.name, source:'upa', industry:a.industry, count:a.count, thumb:a.thumb }))
  // ucCache에 실제로 있는 앱 이름 Set 생성 (대소문자 정규화)
  const ucAppNames = new Set(ucCache.filter(uc=>uc.appName&&uc.images.length).map(uc=>uc.appName.toLowerCase()))
  // upa에서 ucCache에 없는 앱 제거
  const filteredUpa = upa.filter(a => ucAppNames.has(a.name.toLowerCase()))

  // urlCache 기반으로 실제 이미지 있는 slug Set 생성
  const cachedSlugs = new Set([
    ...Object.keys(urlCache.apps),
    ...Object.values(urlCache.paths).flatMap(sg => Object.keys(sg))
  ])
  // tagsDb에서도 slug 추출
  const tagsSlugs = new Set()
  Object.keys(tagsDb).forEach(url => {
    const parts = url.split('/'), pi = parts.indexOf('posts')
    if (pi >= 0 && parts[pi+1]) tagsSlugs.add(parts[pi+1])
  })

  // 버그1/4: 숫자이름, slug=name, 실제 이미지 없는 앱 필터링
  const _SKIP_NAMES = new Set(['logo','icon','banner','splash','image','img','assets','media','thumbnail'])
  const filteredWwit = wwit.filter(a => {
    if (/^\d+$/.test(a.name)) return false
    if (/^\d{4}-\d{2}-\d{2}$/.test(a.name)) return false
    if (/^[a-z0-9_-]+$/.test(a.name) && a.name === a.slug) return false
    if (a.name.length <= 2 && /^[0-9]+$/.test(a.name)) return false
    if (_SKIP_NAMES.has(a.name.toLowerCase())) return false
    // 캐시나 tagsDb에 없는 앱은 제외 (WWIT_APPS에 정의된 앱은 유지)
    if (!WWIT_APPS.some(app => app.slug === a.slug) && !cachedSlugs.has(a.slug) && !tagsSlugs.has(a.slug)) return false
    return true
  })
  return { wwit: filteredWwit, upa: filteredUpa }
})

ipcMain.handle('build-cache', async () => { if (!isBuildingCache) buildCache(null); return true })
ipcMain.handle('rebuild-uc', async () => { buildUseCaseCache(); return true })
ipcMain.handle('cache-status', () => ({ ready: urlCache.updated > 0, appCount: Object.keys(urlCache.apps).length, ucCount: ucCache.length }))
ipcMain.handle('get-upa-cats', () => UPA_CATEGORIES)

ipcMain.handle('scrape-upa-cat', async (_, catId, catName) => {
  const { cat, items } = await upa_scrape_category(catId, catName)
  win?.webContents.send('upa-cat-done', { cat, count: items.length })
  return items
})

ipcMain.handle('save-file', async (_, { url, defaultName }) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: decodeURIComponent(defaultName || url.split('/').pop() || 'image.png'),
    filters: [{ name:'이미지/영상', extensions:['png','webp','jpg','mp4','gif'] }, { name:'모든 파일', extensions:['*'] }]
  })
  if (res.canceled) return false
  // 로컬 file:// 이미지 처리
  if (url.startsWith('file:///') || url.startsWith('file://')) {
    const localPath = decodeURIComponent(url.replace(/^file:\/\/\//,'').replace(/^file:\/\//,''))
    if (!fs.existsSync(localPath)) { console.log('[save] local file not found:', localPath); return false }
    fs.copyFileSync(localPath, res.filePath); return true
  }
  const cp = imgCachePath(url)
  if (fs.existsSync(cp)) { fs.copyFileSync(cp, res.filePath); return true }
  const buf = await fetchBinary(url); if (!buf) return false
  fs.writeFileSync(res.filePath, buf); return true
})

// 이미지 복사 - 렌더러에서 Canvas로 PNG 변환 후 클립보드
ipcMain.handle('copy-image', async (_, url) => {
  try {
    const { clipboard, nativeImage } = require('electron')
    let imgBuf

    // 로컬 파일 (file://) 처리
    if (url.startsWith('file:///') || url.startsWith('file://')) {
      const filePath = decodeURIComponent(url.replace(/^file:\/\/\//,'').replace(/^file:\/\//,''))
      if (!fs.existsSync(filePath)) { console.log('[copy] local file not found:', filePath); return false }
      imgBuf = fs.readFileSync(filePath)
    } else {
      imgBuf = await fetchBinary(url)
    }

    if (!imgBuf || !Buffer.isBuffer(imgBuf)) {
      console.log('[copy] fetch failed:', url)
      return false
    }
    // nativeImage 시도
    const ni = nativeImage.createFromBuffer(imgBuf)
    if (!ni.isEmpty()) {
      clipboard.writeImage(ni)
      console.log('[copy] ok via nativeImage')
      return true
    }
    // webp 등 fallback
    const mime = url.endsWith('.webp') ? 'image/webp' : 'image/png'
    console.log('[copy] nativeImage empty, fallback')
    return { fallback: true, base64: imgBuf.toString('base64'), mime }
  } catch (e) { console.log('[copy] error:', e.message); return false }
})

ipcMain.handle('open-browser', (_, url) => shell.openExternal(url))
ipcMain.handle('get-app-path', () => __dirname)
ipcMain.handle('fetch-image-base64', async (_, url) => {
  try {
    const buf = await fetchBinary(url)
    if (!buf) return null
    return buf.toString('base64')
  } catch(e) { return null }
})

ipcMain.handle('get-upa-urls', () => {
  // ucCache에서 모든 이미지 URL 수집
  const urls = []
  const seen = new Set()
  ucCache.forEach(uc => {
    uc.images.forEach(img => {
      if (img.src && !seen.has(img.src)) {
        seen.add(img.src)
        urls.push(img.src)
      }
    })
  })
  return urls
})

ipcMain.handle('load-tag-progress', () => {
  try {
    const p = path.join(APP_DATA, 'tag_progress.json')
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {}
  return null
})

ipcMain.handle('save-tag-progress', (_, progress) => {
  try {
    fs.writeFileSync(path.join(APP_DATA, 'tag_progress.json'), JSON.stringify(progress), 'utf8')
    return true
  } catch { return false }
})

ipcMain.handle('load-tags', () => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'tags.json'), 'utf8')) }
  catch { return {} }
})

// Claude API 프록시 (Electron CSP 우회)

// UPA 이미지 url → 앱 이름 (ucCache 기준). 자연어 검색에서 UPA 화면을 앱별로 묶고
// 업종 조건과 조합할 수 있도록 렌더러에 내려줌
let _upaAppMap = null, _upaAppMapSize = -1
function upaAppMeta() {
  if (_upaAppMap && _upaAppMapSize === ucCache.length) return _upaAppMap
  const app2cat = {}
  try {
    Object.entries(UPA_APP_CATEGORIES).forEach(([cat, apps]) => {
      apps.forEach(name => { app2cat[name] = cat })
    })
  } catch {}
  const map = {}
  ucCache.forEach(uc => {
    if (!uc || !uc.appName) return
    const industry = [uc.industry || '', app2cat[uc.appName] || ''].filter(Boolean).join('/')
    ;(uc.images || []).forEach(img => { if (img && img.src) map[img.src] = [uc.appName, industry] })
  })
  _upaAppMap = map; _upaAppMapSize = ucCache.length
  return map
}

ipcMain.handle('get-slug-names', () => {
  let upa = {}
  try { upa = upaAppMeta() } catch {}
  return { ...slug2name, __upa: upa }
})
ipcMain.handle('claude-api', async (_, { apiKey, base64Image, prompt, mediaType, model, maxTokens }) => {
  try {
    const https = require('https')
    let content
    if (base64Image) {
      // base64 magic bytes로 실제 이미지 타입 감지
      const buf = Buffer.from(base64Image.slice(0, 16), 'base64')
      let detectedType = mediaType || 'image/png'
      if (buf[0]===0x89 && buf[1]===0x50) detectedType = 'image/png'
      else if (buf[0]===0xFF && buf[1]===0xD8) detectedType = 'image/jpeg'
      else if (buf[0]===0x47 && buf[1]===0x49) detectedType = 'image/gif'
      else if (buf[0]===0x52 && buf[1]===0x49) detectedType = 'image/webp'
      content = [
        { type: 'image', source: { type: 'base64', media_type: detectedType, data: base64Image } },
        { type: 'text', text: prompt }
      ]
    } else {
      // 텍스트 전용 요청 (예: 자연어 검색)
      content = [{ type: 'text', text: prompt }]
    }

    const body = JSON.stringify({
      model: model || 'claude-sonnet-4-5',
      max_tokens: maxTokens || 1000,
      messages: [{ role: 'user', content }]
    })

    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 200) {
            reject(new Error(res.statusCode + ': ' + data))
          } else {
            resolve(JSON.parse(data))
          }
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  } catch(e) { throw new Error(e.message) }
})

// 로컬 이미지 저장 (클립보드/파일 드롭)
ipcMain.handle('save-local-image', async (_, filename, arrayBuffer) => {
  try {
    const localDir = path.join(APP_DATA, 'local_images')
    fs.mkdirSync(localDir, { recursive: true })
    const ext = path.extname(filename) || '.png'
    const name = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2,6) + ext
    const filePath = path.join(localDir, name)
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer))
    // file:// 프로토콜로 반환
    return 'file:///' + filePath.replace(/\\/g, '/')
  } catch(e) { console.log('[save-local] error:', e.message); return null }
})

// 다중 이미지 ZIP 다운로드
ipcMain.handle('download-multiple', async (_, urls) => {
  try {
    const { dialog } = require('electron')
    const result = await dialog.showSaveDialog({
      defaultPath: 'bucci_images.zip',
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    })
    if (result.canceled) return false

    const JSZip = (() => {
      try { return require('jszip') } catch { return null }
    })()

    if (!JSZip) {
      // jszip 없으면 개별 다운로드
      const dir = result.filePath.replace('.zip', '_images')
      fs.mkdirSync(dir, { recursive: true })
      let ok = 0
      for (const url of urls) {
        const buf = await fetchBinary(url)
        if (!buf) continue
        const fname = url.split('/').pop().split('?')[0] || ('img_'+ok+'.png')
        fs.writeFileSync(path.join(dir, fname), buf)
        ok++
      }
      return ok > 0
    }

    const zip = new JSZip()
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      const buf = await fetchBinary(url)
      if (!buf) continue
      const fname = url.split('/').pop().split('?')[0] || ('img_'+i+'.webp')
      zip.file(fname, buf)
    }
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' })
    fs.writeFileSync(result.filePath, zipBuf)
    return true
  } catch(e) { console.log('[download-multiple] error:', e.message); return false }
})

// 컬렉션 영구 저장 (AppData/Roaming/Buchji/collections.json)
const COL_JSON = path.join(APP_DATA, 'collections.json')

// 인메모리 컬렉션 캐시 (동기 저장용)
let _collections = null

ipcMain.handle('load-collections', () => {
  try {
    if (!fs.existsSync(COL_JSON)) {
      _collections = { '좋아요': [] }
      return _collections
    }
    const data = JSON.parse(fs.readFileSync(COL_JSON, 'utf8'))
    _collections = data
    console.log('[collections] loaded:', Object.keys(data))
    return data
  } catch (e) {
    console.log('[collections] load error:', e.message)
    _collections = { '좋아요': [] }
    return _collections
  }
})

ipcMain.handle('save-collections', (_, data) => {
  try {
    // 이전 컬렉션과 비교해서 삭제된 local_images 파일 정리
    if (_collections) {
      const prevLocalSrcs = new Set()
      const newLocalSrcs = new Set()
      Object.values(_collections).forEach(items => items.forEach(i => {
        if (i.src && i.src.startsWith('file:///')) prevLocalSrcs.add(i.src)
      }))
      Object.values(data).forEach(items => items.forEach(i => {
        if (i.src && i.src.startsWith('file:///')) newLocalSrcs.add(i.src)
      }))
      // 모든 컬렉션에서 사라진 파일만 삭제
      prevLocalSrcs.forEach(src => {
        if (!newLocalSrcs.has(src)) {
          try {
            const localPath = decodeURIComponent(src.replace(/^file:\/\/\//,''))
            if (fs.existsSync(localPath)) {
              fs.unlinkSync(localPath)
              console.log('[local-image] deleted:', path.basename(localPath))
            }
          } catch(e) { console.log('[local-image] delete error:', e.message) }
        }
      })
    }
    _collections = data
    fs.writeFileSync(COL_JSON, JSON.stringify(data, null, 2))
    console.log('[collections] saved:', Object.keys(data))
    return true
  } catch (e) {
    console.log('[collections] save error:', e.message)
    return false
  }
})

// 앱 종료 전 컬렉션 동기 저장 보장
app.on('before-quit', () => {
  if (_collections) {
    try {
      fs.writeFileSync(COL_JSON, JSON.stringify(_collections, null, 2))
      console.log('[collections] before-quit saved')
    } catch {}
  }
})

// 조합 검색: 태그 AND 조합 (WWIT + UPA screenName)
ipcMain.handle('combo-search', async (_, selectedTags) => {
  if (!selectedTags || !selectedTags.length) return { data: {} }
  const tagSet = new Set(selectedTags)
  const data = {}

  // WWIT: tags.json에서 선택된 태그를 모두 포함하는 이미지 (AND)
  Object.entries(tagsDb).forEach(([url, imgTags]) => {
    if (!Array.isArray(imgTags) || !url.startsWith('http')) return
    // AND 조건: 선택된 태그 모두 포함
    if (!selectedTags.every(tag => imgTags.includes(tag))) return
    const slugMatch = url.match(/\/images\/posts\/([^\/]+)\//)
    if (!slugMatch) return
    const appName = slug2name[slugMatch[1]] || slugMatch[1]
    if (!data[appName]) data[appName] = []
    data[appName].push({ type:'image', src:url, thumbnail:url, source:'wwit', tags:imgTags })
  })

  // UPA: screenName에 선택된 태그 키워드 포함하는 이미지 (AND)
  ucCache.forEach(uc => {
    if (!uc.appName || !uc.images.length) return
    uc.images.forEach(img => {
      const haystack = [img.screenName || '', uc.title || ''].join(' ').toLowerCase()
      // AND: 모든 태그 키워드가 포함
      if (!selectedTags.every(tag => haystack.includes(tag.toLowerCase()))) return
      if (!data[uc.appName]) data[uc.appName] = []
      data[uc.appName].push({
        type:'image', src:img.src, thumbnail:img.src,
        screenName:img.screenName, source:'upa', ucTitle:uc.title, ucUrl:uc.url
      })
    })
  })

  return { data: filterVideoItems(data), source:'combo' }
})

// use-case 페이지에서 img.media 클릭 → video src 추출
ipcMain.handle('get-uc-video', async (_, ucUrl) => {
  return new Promise(resolve => {
    const w = getUpaWin()
    const timeout = setTimeout(() => resolve(null), 20000)
    w.loadURL(ucUrl)
    w.webContents.once('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, 2500))
        const videoSrc = await w.webContents.executeJavaScript(`
          (async function() {
            const imgs = document.querySelectorAll('img.media, [class*="css-1pg6uaj"] img, [class*="media"] img')
            for (const img of imgs) {
              try {
                img.click()
                await new Promise(r => setTimeout(r, 1200))
                const v = document.querySelector('video[src], [role="dialog"] video, [class*="modal"] video, [class*="overlay"] video, [class*="popup"] video')
                if (v && v.src && v.src.startsWith('http')) {
                  return { src: v.src, poster: v.poster || '' }
                }
                const closeBtn = document.querySelector('[aria-label="close"], [aria-label="Close"], button[class*="close"], [class*="CloseButton"]')
                if (closeBtn) closeBtn.click()
                await new Promise(r => setTimeout(r, 400))
              } catch(e) {}
            }
            return null
          })()
        `)
        clearTimeout(timeout)
        resolve(videoSrc)
      } catch(e) {
        clearTimeout(timeout)
        resolve(null)
      }
    })
  })
})

// 새로고침: 특정 slug 강제 재수집
ipcMain.handle('reload-slug', async (_, slug) => {
  const app = WWIT_APPS.find(a => a.slug === slug)
  if (!app) return { ok: false }
  delete urlCache.apps[slug]
  const html = await fetchHtml(WWIT_BASE + app.page)
  const g    = wwit_parse(html, slug)
  const urls = g[slug] || []
  if (urls.length) { urlCache.apps[slug] = urls; saveCache() }
  return { ok: true, count: urls.length }
})

// 전체 캐시 새로고침
ipcMain.handle('reload-all', async () => {
  // 캐시 초기화 후 스플래시 띄우고 재수집
  urlCache = { apps: {}, paths: {}, updated: 0 }
  ucCache  = []
  saveCache()
  saveUcCache()

  // 스플래시 창 생성
  const splash = createSplashWindow()
  splash.once('ready-to-show', () => splash.show())

  // WWIT 재수집
  await buildCache(splash)
  // UPA 재수집
  splash.webContents.send('splash-phase', { phase: 'uc' })
  await buildUseCaseCache(splash)

  win?.webContents.send('cache-loaded', { appCount: Object.keys(urlCache.apps).length })
  win?.webContents.send('uc-loaded', { count: ucCache.length })
  splash.destroy()
  return true
})

// ── 임베딩 기반 유사화면 검색 ──────────────────────────────────────────
let _embeddings = null  // 메모리 캐시

ipcMain.handle('load-embeddings', () => {
  if (_embeddings) return { count: Object.keys(_embeddings).length, loaded: true }
  const p = path.join(__dirname, 'embeddings.json')
  if (!fs.existsSync(p)) return { count: 0, loaded: false }
  try {
    _embeddings = JSON.parse(fs.readFileSync(p, 'utf8'))
    console.log(`[embed] 로드 완료: ${Object.keys(_embeddings).length}개`)
    return { count: Object.keys(_embeddings).length, loaded: true }
  } catch(e) {
    return { count: 0, loaded: false, error: e.message }
  }
})

ipcMain.handle('voyage-embed', async (_, { apiKey, base64Image, mediaType, hintText }) => {
  // base64 magic bytes로 실제 타입 감지
  const buf = Buffer.from(base64Image.slice(0, 16), 'base64')
  let detectedType = mediaType || 'image/png'
  if (buf[0]===0x89 && buf[1]===0x50) detectedType = 'image/png'
  else if (buf[0]===0xFF && buf[1]===0xD8) detectedType = 'image/jpeg'

  // 공식 형식: content 키 + image_base64에 "data:mime;base64,..." 형태
  const dataUrl = `data:${detectedType};base64,${base64Image}`
  // 텍스트 힌트가 있으면 이미지+텍스트 멀티모달로 전송 → 검색 정확도 향상
  const contentArr = [{ type: 'image_base64', image_base64: dataUrl }]
  if (hintText && hintText.trim()) {
    contentArr.push({ type: 'text', text: hintText.trim() })
  }
  const body = JSON.stringify({
    model: 'voyage-multimodal-3',
    inputs: [{ content: contentArr }]
  })

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.voyageai.com',
      path:     '/v1/multimodalembeddings',
      method:   'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (res.statusCode !== 200) {
          reject(new Error(`Voyage ${res.statusCode}: ${text.slice(0,200)}`))
          return
        }
        try {
          const data = JSON.parse(text)
          resolve(data.data[0].embedding)
        } catch(e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
})

// UPA media id → appName 캐시 (앱 시작 시 빌드)
let _upaIdMap = null
function buildUpaIdMap() {
  if (_upaIdMap) return
  _upaIdMap = {}
  ucCache.forEach(uc => {
    if (!uc.appName) return
    uc.images.forEach(img => {
      const m = img.src && img.src.match(/\/media\/(\d+)\//)
      if (m) _upaIdMap[m[1]] = uc.appName
    })
  })
}

// 앱명으로 오인되는 경로 세그먼트 제외
const SKIP_SLUGS = new Set(['logo','icon','banner','splash','image','img','assets','media','static','thumbnail'])

ipcMain.handle('embed-search', (_, { queryVector, queryUrls, topK }) => {
  if (!_embeddings) return []
  // queryUrls: 이미 임베딩이 저장된 화면들의 url → 그 벡터들의 평균을 질의 벡터로 사용 (API 호출 없음)
  if (!queryVector && Array.isArray(queryUrls)) {
    const vecs = queryUrls.map(u => _embeddings[u]).filter(v => Array.isArray(v) && v.length)
    if (!vecs.length) return []
    const dim = vecs[0].length
    const sum = new Array(dim).fill(0)
    vecs.forEach(v => {
      const n = Math.sqrt(v.reduce((s, x) => s + x*x, 0)) || 1
      for (let i = 0; i < dim; i++) sum[i] += v[i] / n
    })
    queryVector = sum.map(x => x / vecs.length)
  }
  if (!Array.isArray(queryVector) || !queryVector.length) return []
  buildUpaIdMap()
  const k = topK || 40
  const entries = Object.entries(_embeddings)
  if (!entries.length) return []

  const qNorm = Math.sqrt(queryVector.reduce((s, v) => s + v*v, 0))

  const scores = entries.map(([url, vec]) => {
    const dot  = vec.reduce((s, v, i) => s + v * queryVector[i], 0)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v*v, 0))
    const sim  = qNorm > 0 && norm > 0 ? dot / (qNorm * norm) : 0
    let appName = null
    if (url.includes('wouldyoutest')) {
      // UPA: media ID → appName
      const m = url.match(/\/media\/(\d+)\//)
      if (m) appName = _upaIdMap[m[1]] || null
    } else {
      // WWIT: /posts/{slug}/ 에서 slug → slug2name
      const parts = url.split('/')
      const pi = parts.indexOf('posts')
      if (pi >= 0 && parts[pi+1] && !SKIP_SLUGS.has(parts[pi+1])) {
        const name = slug2name[parts[pi+1]]
        if (name && !/^[0-9]+$/.test(name) && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(name))
          appName = name
      }
    }
    return { url, sim, appName }
  })

  scores.sort((a, b) => b.sim - a.sim)
  return scores.slice(0, k)
})

// ── R2 클라우드 PC 레퍼런스 연동 ──────────────────────────────────────
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3')

const R2_CONFIG_PATH = path.join(app.getPath('userData'), 'r2_config.json')

function loadR2Config() {
  try { return JSON.parse(fs.readFileSync(R2_CONFIG_PATH, 'utf8')) } catch { return null }
}
function saveR2Config(cfg) {
  fs.mkdirSync(path.dirname(R2_CONFIG_PATH), { recursive: true })
  fs.writeFileSync(R2_CONFIG_PATH, JSON.stringify(cfg, null, 2))
}
function getR2Client(cfg) {
  return new S3Client({
    region: 'auto',
    endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
  })
}

ipcMain.handle('r2-save-config', (_, cfg) => {
  saveR2Config(cfg)
  return { ok: true }
})
ipcMain.handle('r2-load-config', () => {
  const cfg = loadR2Config()
  if (!cfg) return null
  // Secret key는 렌더러로 다시 내려보내지 않음 (저장 여부만 확인용)
  return { bucket: cfg.bucket, publicUrl: cfg.publicUrl, endpoint: cfg.endpoint, accessKeyId: cfg.accessKeyId, hasSecret: !!cfg.secretAccessKey }
})

// 업로드: 원본 + 썸네일(480px) 동시 생성 후 R2에 업로드
ipcMain.handle('r2-upload-image', async (_, { fileBuffer, thumbBuffer, fileName, label, mode, brandId }) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요' }
  const m = (mode === 'mobile') ? 'mobile' : 'pc'
  try {
    const client = getR2Client(cfg)
    const buf = Buffer.from(fileBuffer)
    const thumbBuf = Buffer.from(thumbBuffer)
    const ext = path.extname(fileName) || '.png'
    const baseId = Date.now() + '_' + Math.random().toString(36).slice(2,8)
    const origKey = `cloud-refs/${m}/original/${baseId}${ext}`
    const thumbKey = `cloud-refs/${m}/thumb/${baseId}.jpg`

    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: origKey, Body: buf, ContentType: 'image/' + ext.replace('.','') }))
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: thumbKey, Body: thumbBuf, ContentType: 'image/jpeg' }))

    // 등록된 브랜드 정보(이름, 로고 URL)를 조회해서 메타에 함께 저장
    let brandName = '', brandLogoUrl = ''
    if (brandId) {
      const brands = await loadBrandsListStrict(client, cfg)
      const b = brands.find(x => x.id === brandId)
      if (b) { brandName = b.name; brandLogoUrl = b.logoUrl }
    }

    const meta = {
      id: baseId, label: label || fileName, brandId: brandId || '', brand: brandName, brandLogoUrl, mode: m, origKey, thumbKey,
      origUrl: cfg.publicUrl + '/' + origKey, thumbUrl: cfg.publicUrl + '/' + thumbKey,
      uploadedAt: new Date().toISOString(), tags: []
    }
    // 메타데이터는 별도 JSON 객체로 R2에도 백업 저장 (간단한 목록 관리용)
    await saveR2Meta(client, cfg, meta)
    return { ok: true, meta }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('r2-update-brand', async (_, { id, brandId }) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요' }
  try {
    const client = getR2Client(cfg)
    const list = await loadR2MetaListStrict(client, cfg)
    const item = list.find(i => i.id === id)
    if (item) {
      if (brandId) {
        const brands = await loadBrandsListStrict(client, cfg)
        const b = brands.find(x => x.id === brandId)
        item.brandId = brandId
        item.brand = b ? b.name : ''
        item.brandLogoUrl = b ? b.logoUrl : ''
      } else {
        item.brandId = ''; item.brand = ''; item.brandLogoUrl = ''
      }
    }
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: R2_META_KEY, Body: JSON.stringify(list, null, 2), ContentType: 'application/json' }))
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// 업로드 시 계산한 임베딩 벡터를 메타에 저장 (클라우드 PC 유사화면 검색용)
ipcMain.handle('r2-save-embedding', async (_, { id, vector }) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요' }
  try {
    const client = getR2Client(cfg)
    const list = await loadR2MetaListStrict(client, cfg)
    const item = list.find(i => i.id === id)
    if (item) item.embedding = vector
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: R2_META_KEY, Body: JSON.stringify(list, null, 2), ContentType: 'application/json' }))
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// 클라우드 PC 레퍼런스 중 임베딩이 저장된 이미지들과 쿼리 벡터를 코사인 유사도로 비교
ipcMain.handle('r2-embed-search', async (_, { queryVector, mode, topK }) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요', results: [] }
  try {
    const client = getR2Client(cfg)
    const list = await loadR2MetaListStrict(client, cfg)
    const m = mode === 'mobile' ? 'mobile' : 'pc'
    const candidates = list.filter(i => (i.mode || 'pc') === m && Array.isArray(i.embedding))
    const qNorm = Math.sqrt(queryVector.reduce((s, v) => s + v*v, 0))
    const scores = candidates.map(item => {
      const vec = item.embedding
      const dot = vec.reduce((s, v, i) => s + v * queryVector[i], 0)
      const norm = Math.sqrt(vec.reduce((s, v) => s + v*v, 0))
      const sim = qNorm > 0 && norm > 0 ? dot / (qNorm * norm) : 0
      return { id: item.id, label: item.label, brand: item.brand, origUrl: item.origUrl, thumbUrl: item.thumbUrl, sim }
    })
    scores.sort((a, b) => b.sim - a.sim)
    return { ok: true, results: scores.slice(0, topK || 40) }
  } catch (e) {
    return { ok: false, error: e.message, results: [] }
  }
})

// ── 브랜드(로고) 레지스트리 ──────────────────────────────────────────
const R2_BRANDS_KEY = 'cloud-refs/_brands.json'

async function loadBrandsListStrict(client, cfg) {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: R2_BRANDS_KEY }))
    const text = await res.Body.transformToString()
    return JSON.parse(text)
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey') return []
    throw e
  }
}

ipcMain.handle('r2-list-brands', async () => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요', brands: [] }
  try {
    const client = getR2Client(cfg)
    const brands = await loadBrandsListStrict(client, cfg)
    return { ok: true, brands }
  } catch (e) {
    return { ok: false, error: e.message, brands: [] }
  }
})

ipcMain.handle('r2-add-brand', async (_, { name, logoBuffer, logoFileName, category }) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요' }
  if (!name || !name.trim()) return { ok: false, error: '브랜드명을 입력해주세요' }
  if (!logoBuffer || !logoBuffer.length) return { ok: false, error: '로고 이미지는 필수예요' }
  try {
    const client = getR2Client(cfg)
    const brands = await loadBrandsListStrict(client, cfg)
    if (brands.find(b => b.name === name)) return { ok: false, error: '이미 등록된 브랜드명이에요' }

    const id = Date.now() + '_' + Math.random().toString(36).slice(2,8)
    const ext = path.extname(logoFileName) || '.png'
    const logoKey = `cloud-refs/brand-logos/${id}${ext}`
    const buf = Buffer.from(logoBuffer)
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: logoKey, Body: buf, ContentType: 'image/' + ext.replace('.','') }))

    const brand = { id, name, category: category || '', logoKey, logoUrl: cfg.publicUrl + '/' + logoKey, createdAt: new Date().toISOString() }
    brands.unshift(brand)
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: R2_BRANDS_KEY, Body: JSON.stringify(brands, null, 2), ContentType: 'application/json' }))
    return { ok: true, brand }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('r2-update-brand-category', async (_, { id, category }) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요' }
  try {
    const client = getR2Client(cfg)
    const brands = await loadBrandsListStrict(client, cfg)
    const item = brands.find(b => b.id === id)
    if (item) item.category = category || ''
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: R2_BRANDS_KEY, Body: JSON.stringify(brands, null, 2), ContentType: 'application/json' }))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('r2-delete-brand', async (_, { id }) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요' }
  try {
    const client = getR2Client(cfg)
    const brands = await loadBrandsListStrict(client, cfg)
    const item = brands.find(b => b.id === id)
    if (item) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: item.logoKey }))
    }

    // 이 브랜드에 속한 이미지들을 모두 같이 삭제 (원본 + 썸네일 + 메타)
    const imageList = await loadR2MetaListStrict(client, cfg)
    const belongs = imageList.filter(img => img.brandId === id)
    for (const img of belongs) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: img.origKey }))
        await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: img.thumbKey }))
      } catch { /* 개별 파일 삭제 실패해도 나머지 진행 */ }
    }
    const remainingImages = imageList.filter(img => img.brandId !== id)
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: R2_META_KEY, Body: JSON.stringify(remainingImages, null, 2), ContentType: 'application/json' }))

    const newBrandList = brands.filter(b => b.id !== id)
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: R2_BRANDS_KEY, Body: JSON.stringify(newBrandList, null, 2), ContentType: 'application/json' }))
    return { ok: true, deletedImageCount: belongs.length }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})


const R2_META_KEY = 'cloud-refs/_meta.json'

// 에러를 삼키지 않는 메타 로더 - 권한/인증 문제를 사용자에게 정확히 보여주기 위함
async function loadR2MetaListStrict(client, cfg) {
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: R2_META_KEY }))
    const text = await res.Body.transformToString()
    return JSON.parse(text)
  } catch (e) {
    // 메타파일이 아직 없는 최초 상태(NoSuchKey)는 정상 - 빈 배열
    if (e.name === 'NoSuchKey' || e.Code === 'NoSuchKey') return []
    throw e // 그 외 에러(권한, 인증, 네트워크 등)는 그대로 위로 전달
  }
}
async function saveR2Meta(client, cfg, newItem) {
  const list = await loadR2MetaListStrict(client, cfg)
  list.unshift(newItem)
  await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: R2_META_KEY, Body: JSON.stringify(list, null, 2), ContentType: 'application/json' }))
}

ipcMain.handle('r2-list-images', async (_, { mode } = {}) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요', images: [] }
  try {
    const client = getR2Client(cfg)
    let images = await loadR2MetaListStrict(client, cfg)
    if (mode) images = images.filter(i => (i.mode || 'pc') === mode)
    return { ok: true, images }
  } catch (e) {
    return { ok: false, error: e.message, images: [] }
  }
})

ipcMain.handle('r2-update-tags', async (_, { id, tags }) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요' }
  try {
    const client = getR2Client(cfg)
    const list = await loadR2MetaListStrict(client, cfg)
    const item = list.find(i => i.id === id)
    if (item) item.tags = tags
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: R2_META_KEY, Body: JSON.stringify(list, null, 2), ContentType: 'application/json' }))
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('r2-delete-image', async (_, { id }) => {
  const cfg = loadR2Config()
  if (!cfg) return { ok: false, error: 'R2 설정이 없어요' }
  try {
    const client = getR2Client(cfg)
    const list = await loadR2MetaListStrict(client, cfg)
    const item = list.find(i => i.id === id)
    if (item) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: item.origKey }))
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: item.thumbKey }))
    }
    const newList = list.filter(i => i.id !== id)
    await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: R2_META_KEY, Body: JSON.stringify(newList, null, 2), ContentType: 'application/json' }))
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})
