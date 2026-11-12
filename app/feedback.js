/**
 * 부찌 의견 보내기
 * ─────────────────────────────────────────────────────────
 * 사용자가 적은 내용을 구글 설문지("부찌 업데이트 요청")로 보냅니다. 익명이며, 내용과 부찌 버전만 전송합니다.
 * 응답은 설문지의 "응답" 탭(또는 연결한 구글 시트)에서 확인합니다.
 * 설문지를 새로 만들면 FORM 주소와 칸 번호(entry.…)를 바꿔야 합니다.
 */
const http = require('http')
const https = require('https')

const FORM = process.env.BUCCI_FEEDBACK_URL || 'https://docs.google.com/forms/d/e/1FAIpQLSf5Y9XkdHbBe2cRacmCXwpMroUDarecnjFWJghv1IdtlgEn8A/formResponse'
const FIELD_TEXT = 'entry.372532024'      // 내용
const FIELD_VERSION = 'entry.1403119297'  // 버전
const MAX_LEN = 3000

// 반환: { ok:true } 또는 { ok:false, reason:'empty'|'offline'|'rejected' }
function send(text, version) {
  text = String(text || '').trim().slice(0, MAX_LEN)
  if (!text) return Promise.resolve({ ok: false, reason: 'empty' })
  const body = new URLSearchParams({ [FIELD_TEXT]: text, [FIELD_VERSION]: String(version || '') }).toString()
  return new Promise(resolve => {
    let done = false
    const finish = r => { if (!done) { done = true; resolve(r) } }
    try {
      const u = new URL(FORM)
      const req = (u.protocol === 'https:' ? https : http).request(u, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'bucci-feedback' }
      }, res => {
        res.resume()
        // 구글 설문지는 접수되면 200, 칸 번호가 틀리거나 설문이 닫혀 있으면 400대를 돌려줌
        res.on('end', () => finish(res.statusCode === 200 ? { ok: true } : { ok: false, reason: 'rejected', status: res.statusCode }))
        res.on('error', () => finish({ ok: false, reason: 'offline' }))
      })
      req.on('error', () => finish({ ok: false, reason: 'offline' }))
      req.setTimeout(10000, () => req.destroy(new Error('timeout')))
      req.end(body)
    } catch { finish({ ok: false, reason: 'offline' }) }
  })
}

module.exports = { send }
