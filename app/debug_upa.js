// 이 파일을 앱 실행 후 개발자 콘솔에서 실행
// window.api.debugUpa() 호출

// UPA 구조 분석용 스크립트 - Electron main에서 실행할 JS
const SCRIPT = `
(function() {
  const result = {
    // 카드 구조 분석
    cards: [],
    videoElements: [],
    networkRequests: [],
    nextData: null,
  }

  // __NEXT_DATA__ 확인
  try {
    const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}')
    result.nextData = {
      keys: Object.keys(nd?.props?.pageProps || {}),
      sample: JSON.stringify(nd?.props?.pageProps).slice(0, 500)
    }
  } catch(e) { result.nextData = { error: e.message } }

  // 카드 요소들 찾기
  const possibleCards = document.querySelectorAll('[class*="card"], [class*="Card"], [class*="item"], [class*="Item"], [class*="pattern"], [class*="Pattern"]')
  possibleCards.forEach((el, i) => {
    if (i > 20) return
    const appName = el.querySelector('[class*="app"], [class*="App"], [class*="name"], [class*="Name"], h1, h2, h3, h4, p')?.innerText
    const video = el.querySelector('video')
    const img = el.querySelector('img')
    result.cards.push({
      className: el.className.slice(0, 100),
      appName: appName?.trim().slice(0, 50),
      hasVideo: !!video,
      videoSrc: video?.src || video?.querySelector('source')?.src,
      imgSrc: img?.src?.slice(0, 100),
      innerHTML: el.innerHTML.slice(0, 200)
    })
  })

  // video 요소 전체
  document.querySelectorAll('video').forEach(v => {
    result.videoElements.push({
      src: v.src,
      poster: v.poster,
      sources: Array.from(v.querySelectorAll('source')).map(s => s.src),
      paused: v.paused,
      readyState: v.readyState,
      currentSrc: v.currentSrc,
      dataset: JSON.stringify(v.dataset).slice(0, 100),
      parentClass: v.parentElement?.className?.slice(0, 100),
      outerHTML: v.outerHTML.slice(0, 300)
    })
  })

  // 전체 텍스트에서 앱이름|카테고리 패턴 찾기
  const allText = document.body.innerText
  const pipeMatches = allText.match(/[가-힣a-zA-Z0-9]+\s*\|\s*[가-힣a-zA-Z\/]+/g) || []
  result.pipePattern = pipeMatches.slice(0, 20)

  // 이미지 src 패턴
  const imgs = Array.from(document.images)
  result.imageSrcs = imgs.filter(i => i.width > 50).map(i => i.src).slice(0, 10)

  return result
})()
`

console.log('UPA 디버그 스크립트 준비됨')
console.log('Electron main.js의 upa_scrape_category 함수에 이 스크립트 적용 필요')

module.exports = SCRIPT
