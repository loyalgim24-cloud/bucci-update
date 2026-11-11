// 디버그용 - Electron main process에서 실행
// 실제 HTML 구조 확인

const https = require('https')
const fs    = require('fs')
const path  = require('path')
const os    = require('os')

const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Accept-Encoding': 'identity',  // gzip 비활성화 - 디코딩 문제 방지
  'Connection': 'close',
}

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const req = https.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: HDR
    }, res => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        encoding: res.headers['content-encoding'],
        type: res.headers['content-type'],
        body: Buffer.concat(chunks)
      }))
    })
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function debug() {
  const url = 'https://wwit.design/2025/02/15/npay'
  console.log('Fetching:', url)
  
  try {
    const { status, encoding, type, body } = await fetchRaw(url)
    console.log('Status:', status)
    console.log('Content-Encoding:', encoding)
    console.log('Content-Type:', type)
    console.log('Body size:', body.length, 'bytes')
    
    const html = body.toString('utf8')
    console.log('\n=== HTML 앞 500자 ===')
    console.log(html.substring(0, 500))
    
    console.log('\n=== images/posts 포함 여부 ===')
    const hasImages = html.includes('/images/posts/')
    console.log('포함:', hasImages)
    
    if (hasImages) {
      const idx = html.indexOf('/images/posts/')
      console.log('첫 등장 위치:', idx)
      console.log('주변 컨텍스트:', html.substring(idx - 30, idx + 80))
    }
    
    // __NEXT_DATA__ 확인
    const ndIdx = html.indexOf('__NEXT_DATA__')
    if (ndIdx >= 0) {
      console.log('\n=== __NEXT_DATA__ 발견 ===')
      console.log(html.substring(ndIdx, ndIdx + 200))
    }
    
    // gzip 가능성 확인
    console.log('\n=== body 첫 4바이트 (hex) ===')
    console.log(body.slice(0, 4).toString('hex'))
    // 1f8b = gzip, 3c21 = HTML
    
    // 결과를 파일로 저장
    const outPath = path.join(os.homedir(), 'Desktop', 'wwit_debug.html')
    fs.writeFileSync(outPath, html, 'utf8')
    console.log('\n=== HTML 저장됨:', outPath, '===')
    
  } catch (e) {
    console.error('Error:', e.message)
  }
}

debug()
