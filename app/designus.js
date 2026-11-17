// 디자이너스(designus.design) 레퍼런스
// 깃허브에서 매달 자동으로 모아 둔 목록(designus_refs.json)을 부찌 자료 형태로 바꿔 줌.
// 목록 만들기는 bucci-update 저장소의 designus/designus_collect.js 가 담당.

const URL = 'https://raw.githubusercontent.com/loyalgim24-cloud/bucci-update/designus-data/designus_refs.json'

// 중복 기준: 수집할 때 부찌에 이미 있는 화면과 비교해 둔 "다른 정도"(0 = 완전히 같음, 클수록 다름).
// 이 값 이하면 같은 화면으로 보고 디자이너스 쪽을 숨김. 값을 키우면 더 많이 숨김.
const DUP_MAX = 8

// data: 수집 결과, knownNames: 부찌에 이미 있는 앱 이름들, norm: 이름 비교용 정리 함수
function build(data, knownNames, norm) {
  const canon = {}
  ;(knownNames || []).forEach(n => { const k = norm(n); if (k && !canon[k]) canon[k] = n })
  const ucs = [], tags = {}, extra = {}, appByUrl = {}
  let hidden = 0
  ;(data.apps || []).forEach(a => {
    if (!a || !a.name || !Array.isArray(a.screens)) return
    let name = String(a.name).trim()
    if (/\([^)]*$/.test(name)) name += ')'                       // 예전 수집본에서 잘린 이름
    const appName = canon[norm(name)] || name                    // 이미 있는 앱이면 같은 이름으로 묶음
    const images = []
    a.screens.forEach(s => {
      if (!s || !s.thumb || !/^https:\/\//.test(s.thumb)) return
      const t = [...new Set([...(s.tags || []), ...(s.color || [])])]
      if (Array.isArray(s.dup) && s.dup[1] <= DUP_MAX) {         // 이미 있는 화면과 같음 → 숨기고 분류만 넘겨줌
        hidden++
        if ((s.tags || []).length) extra[s.dup[0]] = [...new Set([...(extra[s.dup[0]] || []), ...s.tags])]
        return
      }
      tags[s.thumb] = [...t, appName]
      appByUrl[s.thumb] = appName
      images.push({ src: s.thumb, screenName: appName })
    })
    if (images.length) ucs.push({ id: 'dz_' + a.id, _dz: true, title: '', appName, industry: '', images, url: '', hasMedia: false })
  })
  return { ucs, tags, extra, appByUrl, hidden }
}

// 목록에는 작은 이미지를 쓰고, 크게 볼 때·저장·복사할 때는 원본 크기 주소로 바꿈
function big(url) { return /^https:\/\/static\.designus\.design\/.+_small\.webp$/.test(String(url)) ? url.replace(/_small\.webp$/, '.webp') : url }

module.exports = { URL, DUP_MAX, build, big }
