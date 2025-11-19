// 1. 필요한 라이브러리 가져오기
require('dotenv').config(); // .env 파일의 환경변수를 process.env에 로드
const puppeteer = require('puppeteer');
const fs = require('fs').promises; // 파일 시스템 모듈 추가
const cron = require('node-cron');

// Slack 연동을 위한 라이브러리
const { WebClient } = require('@slack/web-api');

// 랜덤 지연 시간을 위한 헬퍼 함수
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// 한국 시간 타임스탬프 생성 함수 (yyyy-mm-dd hh:mm)
function getKSTTimestamp() {
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000; // KST는 UTC+9
  const kstNow = new Date(now.getTime() + kstOffset);
  const year = kstNow.getUTCFullYear();
  const month = String(kstNow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kstNow.getUTCDate()).padStart(2, '0');
  const hours = String(kstNow.getUTCHours()).padStart(2, '0');
  const minutes = String(kstNow.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// 시가총액 문자열을 숫자(억 단위)로 변환하는 함수
function parseMarketCapToBillions(marketCapStr) {
  if (typeof marketCapStr !== 'string' || !marketCapStr) return 0;

  let totalBillions = 0;
  const str = marketCapStr.replace(/,/g, ''); // "2조4674억"

  if (str.includes('조')) {
    const parts = str.split('조');
    totalBillions += parseInt(parts[0], 10) * 10000;
    if (parts[1] && parts[1].includes('억')) {
      totalBillions += parseInt(parts[1].replace('억', ''), 10);
    }
  } else if (str.includes('억')) {
    totalBillions += parseInt(str.replace('억', ''), 10);
  }
  return totalBillions;
}

// 슬랙 메시지 전송 함수
async function sendSlackNotification(stocks) {
  const token = process.env.SLACK_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel || stocks.length === 0) {
    console.log('\n슬랙 알림을 보낼 정보가 없거나, 대상 종목이 없습니다.');
    return;
  }

  const slackClient = new WebClient(token);

  // 날짜에 따라 동적으로 색상 결정
  const dayOfMonth = new Date().getDate();
  const attachmentColor = (dayOfMonth % 2 === 0) ? "#D00000" : "#2EB67D"; // 짝수일: 빨간색, 홀수일: 초록색

  const timestamp = getKSTTimestamp();
  const title = `[${timestamp}] 📈 목표주가 대비 저평가 종목 알림 (${stocks.length}건)`;
  const body =
    stocks.map(s => `• <https://m.stock.naver.com/domestic/stock/${s.code}/total|[${s.code}] ${s.name}> | 시총: ${s.marketCap} | 현재가: ${s.currentPrice} | 목표가: ${s.targetPrice} | 괴리율: ${s.gap.toFixed(2)}%`).join('\n');

  await slackClient.chat.postMessage({
    channel,
    text: title, // 푸시 알림 등에서 사용될 요약 텍스트
    unfurl_links: false, // 링크 미리보기(썸네일) 비활성화
    attachments: [
      {
        color: attachmentColor,
        title: title,
        text: body
      }
    ]
  });
  console.log('\n슬랙으로 알림을 성공적으로 전송했습니다.');
}

// 2. 크롤링할 메인 함수 정의 (비동기 async/await 사용)
async function scrapeStockData() {
  const SKIP_LIST_FILE = 'skip-list.txt';

  // --- 월간 초기화 로직 ---
  const today = new Date();
  // getDay() [0:일, 1:월], getDate() [1-31]
  const isFirstMonday = today.getDay() === 1 && today.getDate() <= 7;

  if (isFirstMonday) {
    try {
      await fs.unlink(SKIP_LIST_FILE);
      console.log(`[초기화] 오늘은 첫 번째 월요일입니다. ${SKIP_LIST_FILE} 파일을 삭제하고 모든 종목을 점검합니다.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error; // 파일이 없는 경우 외의 에러는 throw
      console.log(`[정보] 오늘은 첫 번째 월요일이지만, ${SKIP_LIST_FILE} 파일이 없어 초기화를 건너뜁니다.`);
    }
  }

  // --- 건너뛰기 목록 로드 및 필터링 ---
  let skipCodes = new Set();
  try {
    const skipData = await fs.readFile(SKIP_LIST_FILE, 'utf-8');
    skipCodes = new Set(skipData.split('\n').filter(code => code.trim() !== ''));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error; // 파일이 없는 경우 외의 에러는 throw
    // 파일이 없을 때(ENOENT)는 정상적인 상황이므로, 로그를 남겨 사용자에게 알려줍니다.
    console.log(`[정보] ${SKIP_LIST_FILE} 파일이 없어 모든 종목을 대상으로 크롤링을 시작합니다.`);
  }

  // .env 파일에서 주식 코드 목록을 가져와 배열로 변환
  const allStockCodes = process.env.STOCK_CODES.split(',');
  const stockCodes = allStockCodes.filter(code => !skipCodes.has(code));

  if (!allStockCodes || allStockCodes.length === 0) {
    console.log('환경변수(.env)에 STOCK_CODES를 설정해주세요.');
    return;
  }

  console.log('Puppeteer 브라우저를 실행합니다...');
  // .env 파일에서 HEADLESS_MODE 값을 읽어옴 ('false'가 아니면 모두 headless로 간주)
  const isHeadless = process.env.HEADLESS_MODE !== 'false';
  console.log(`브라우저 모드: ${isHeadless ? 'Headless' : 'GUI'}`);

  const browser = await puppeteer.launch({
    // isHeadless가 true이면 "new"(헤드리스), false이면 false(GUI)로 설정
    headless: isHeadless ? "new" : false
  });

  const results = [];

  const totalStartTime = Date.now(); // 전체 작업 시작 시간 기록
  console.log(`총 ${allStockCodes.length}개 종목 중 ${skipCodes.size}개를 건너뛰고, ${stockCodes.length}개에 대한 크롤링을 시작합니다.`);

  const notificationBatch = []; // 슬랙 알림을 위한 임시 저장 배열
  const BATCH_SIZE = 5; // 5개씩 잘라서 알림 전송

  // 3. 각 종목 코드에 대해 순차적으로 작업 수행
  for (const [index, code] of stockCodes.entries()) {
    const itemStartTime = Date.now();
    let page; // page 변수를 try 블록 외부에서 선언
    
    try {
      // 진행률 로깅을 위해 page 생성도 try 블록 안으로 이동
      page = await browser.newPage();

      // 사용자 에이전트 설정 (페이지 생성 직후로 이동)
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');

      // 1. 요청 가로채기 활성화
      await page.setRequestInterception(true);

      // 2. 이벤트 리스너 등록: 불필요한 리소스 차단
      page.on('request', (req) => {
        // stylesheet를 차단하면 렌더링이 멈출 수 있으므로, 이미지/폰트/미디어만 차단하는 것이 더 안전합니다.
        ['image', 'font', 'media'].includes(req.resourceType()) ? req.abort() : req.continue();
      });

      // 3. 모든 설정이 끝난 후 페이지로 이동
      const url = `https://m.stock.naver.com/domestic/stock/${code}/total`;
      console.log(`[${index + 1}/${stockCodes.length}] [${code}] 페이지로 이동 중: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2' });

      // 4. '동일 업종 비교' 텍스트가 나타날 때까지 최대 30초 대기
      // 이 부분이 동적 컨텐츠를 기다리는 핵심입니다.
      console.log(`[${index + 1}/${stockCodes.length}] [${code}] 컨텐츠 로드를 기다립니다...`);
      // 클래스 이름은 자주 바뀌므로, 'strong' 태그 전체를 대상으로 텍스트를 검색하는 것이 더 안정적입니다.
      // 이전 셀렉터: 'strong.title'
      const comparisonSelector = 'strong';
      await page.waitForFunction(
        (selector) => {
          const elements = Array.from(document.querySelectorAll(selector));
          return elements.some(el => el.textContent.includes('동일 업종 비교'));
        },
        { timeout: 30000 }, // 최대 30초 대기
        comparisonSelector
      );
      console.log(`[${index + 1}/${stockCodes.length}] [${code}] 컨텐츠 로드 완료.`);

      // 5. 데이터 추출 (page.evaluate 사용)
      // page.evaluate는 브라우저의 컨텍스트에서 코드를 실행합니다.
      const stockData = await page.evaluate(() => {
        // 종목명 추출
        // 동적으로 변경되는 클래스명에 대응하기 위해 부분 일치 셀렉터 '[class*="..."]'를 사용합니다.
        const nameElement = document.querySelector('span[class*="GraphMain_name__"]');
        const name = nameElement ? nameElement.innerText.trim() : '종목명 없음';

        // 현재가 추출
        const currentPriceElement = document.querySelector('strong[class*="GraphMain_price__"]');
        const currentPrice = currentPriceElement ? currentPriceElement.innerText.replace('원', '').trim() : '현재가 없음';

        // 목표주가 추출
        // 마찬가지로 부분 일치 셀렉터를 사용하여 안정성을 높입니다.
        const targetPriceElement = document.querySelector('span[class*="Consensus_price__"]');
        // '원' 글자를 제외하고 숫자와 쉼표만 남깁니다.
        const targetPrice = targetPriceElement ? targetPriceElement.innerText.replace('원', '').trim() : '목표주가 없음';

        // 시가총액(시총) 추출
        let marketCap = '시총 없음';
        // 1. 모든 정보 아이템의 '키'를 가져옵니다.
        const keys = Array.from(document.querySelectorAll('strong[class*="StockInfo_key__"]'));
        // 2. '키' 중에서 텍스트가 '시총'인 것을 찾습니다.
        const marketCapKeyElement = keys.find(el => el.innerText.trim() === '시총');
        if (marketCapKeyElement) {
          // 3. 찾은 '키'의 부모 요소에서 '값'을 찾습니다.
          const marketCapValueElement = marketCapKeyElement.parentElement.querySelector('span[class*="StockInfo_value__"]');
          marketCap = marketCapValueElement ? marketCapValueElement.innerText.trim() : '시총 없음';
        }

        return { name, currentPrice, targetPrice, marketCap };
      });

      const itemDuration = ((Date.now() - itemStartTime) / 1000).toFixed(2); // 개별 작업 소요 시간 (초)
      results.push({ code, ...stockData });
      console.log(`[${index + 1}/${stockCodes.length}] [${code}] 데이터 추출 성공: ${stockData.name}, 시총: ${stockData.marketCap}, 현재가: ${stockData.currentPrice}, 목표가: ${stockData.targetPrice} (${itemDuration}초)`);

      // 목표주가가 없는 경우, skip-list.txt에 추가
      if (stockData.targetPrice === '목표주가 없음') {
        console.log(`[!] '${stockData.name}' 종목은 목표주가가 없어 다음부터 건너뜁니다.`);
        await fs.appendFile(SKIP_LIST_FILE, `${code}\n`);
      }

      // 실시간 가격 분석
      const gapPercentage = parseFloat(process.env.PRICE_GAP_PERCENTAGE);
      if (!isNaN(gapPercentage)) {
        const current = parseInt(String(stockData.currentPrice).replace(/,/g, ''), 10);
        const target = parseInt(String(stockData.targetPrice).replace(/,/g, ''), 10);
        const minMarketCap = parseInt(process.env.MIN_MARKET_CAP_BILLIONS, 10) || 0;
        const marketCapInBillions = parseMarketCapToBillions(stockData.marketCap);

        if (!isNaN(current) && !isNaN(target) && target > 0) {
          const gap = ((target - current) / target) * 100;
          // 괴리율과 최소 시총 조건을 모두 만족하는 경우에만 알림 대상에 추가
          if (gap >= gapPercentage && marketCapInBillions >= minMarketCap) {
            console.log(`[!] 알림 대상 발견: ${stockData.name} (괴리율: ${gap.toFixed(2)}%)`);
            notificationBatch.push({ code, ...stockData, gap });
          } else if (gap >= gapPercentage && marketCapInBillions < minMarketCap) {
            console.log(`[!] '${stockData.name}'은(는) 괴리율 조건은 만족하나, 시총(${stockData.marketCap})이 기준 미달이라 제외됩니다.`);
          }
        }
      }

    } catch (error) {
      const itemDuration = ((Date.now() - itemStartTime) / 1000).toFixed(2);
      // 에러의 상세 내용을 확인하기 위해 error 객체 전체를 출력합니다.
      console.error(`[${index + 1}/${stockCodes.length}] [${code}] 처리 중 오류 발생 (${itemDuration}초):`, error.name);
      results.push({ code, name: '오류 발생', currentPrice: '오류 발생', targetPrice: '오류 발생', marketCap: '오류 발생' });
    } finally {
      if (page) {
        await page.close(); // 페이지가 성공적으로 생성된 경우에만 닫기
      }

      // 다음 요청 전에 랜덤 지연 시간 추가 (예: 2초 ~ 5초)
      const delay = getRandomDelay(2000, 5000);
      console.log(`다음 작업을 위해 ${delay / 1000}초 대기합니다...`);
      await sleep(delay);
    }
  }

  // 6. 브라우저 종료 및 결과 출력
  await browser.close();

  // 총 실행 시간 계산
  const totalDuration = (Date.now() - totalStartTime) / 1000;
  const minutes = Math.floor(totalDuration / 60);
  const seconds = (totalDuration % 60).toFixed(2);

  console.log('\n--- 최종 크롤링 결과 ---');
  console.table(results); // 결과를 표 형태로 깔끔하게 출력
  console.log(`총 실행 시간: ${minutes > 0 ? `${minutes}분 ` : ''}${seconds}초`);

  // 7. 수집된 모든 알림 대상을 정렬 후, 배치로 슬랙 전송
  if (notificationBatch.length > 0) {
    console.log(`\n[!] 총 ${notificationBatch.length}개의 알림 대상을 발견했습니다. 괴리율 순으로 정렬 후 슬랙으로 전송합니다...`);

    // 괴리율(gap)이 높은 순서대로 정렬
    notificationBatch.sort((a, b) => a.gap - b.gap); // 괴리율이 낮은 순서대로 정렬

    // 10개씩 잘라서 순차적으로 메시지 전송
    for (let i = 0; i < notificationBatch.length; i += BATCH_SIZE) {
      const chunk = notificationBatch.slice(i, i + BATCH_SIZE);
      await sendSlackNotification(chunk);
      // 슬랙 API 속도 제한을 피하기 위해 메시지 사이에 약간의 딜레이를 줍니다.
      if (i + BATCH_SIZE < notificationBatch.length) await sleep(1000);
    }
  }
}

// 8. 스케줄러 설정 및 실행
let isScraping = false; // 동시 실행 방지 플래그

// .env에서 스케줄을 가져오거나, 없으면 기본값(매일 아침 7시) 사용
const cronSchedule = process.env.CRON_SCHEDULE || '0 7 * * *';

console.log(`[크롤러 준비 완료] 스케줄(${cronSchedule})에 따라 작업을 실행합니다.`);

cron.schedule(cronSchedule, async () => {
  console.log(`\n[${new Date().toLocaleString()}] 스케줄된 크롤링 작업을 시작합니다.`);

  if (isScraping) {
    console.log('[경고] 이전 크롤링 작업이 아직 실행 중입니다. 이번 작업은 건너뜁니다.');
    return;
  }

  try {
    isScraping = true;
    await scrapeStockData();
  } catch (error) {
    console.error('[오류] 스케줄된 작업 실행 중 최상위 레벨에서 오류가 발생했습니다:', error);
  } finally {
    isScraping = false;
    console.log(`\n[${new Date().toLocaleString()}] 크롤링 작업이 완료되었습니다. 다음 스케줄을 기다립니다.`);
  }
});

// 참고: 스크립트 시작 시 즉시 1회 실행하고 싶다면 아래 주석을 해제하세요.
// scrapeStockData();
