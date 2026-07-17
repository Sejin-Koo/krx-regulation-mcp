// rule.krx.co.kr (KRX 법무포털) 실시간 조문 원문 조회 클라이언트
//
// 이 사이트는 검색(outsearch.do)과 트리 브라우징(getTreeNode.do)이 세션/JS 상태에
// 의존적이라 순수 HTTP 재현이 되지 않는다(2026.7 확인, 여러 방식 시도 후 결론).
// 반면 "bookid를 이미 아는 특정 문서"를 regulationViewPop.do로 직접 조회하는 것은
// 매 요청마다 새 세션(GET / → 쿠키+CSRF 토큰 획득)만 거치면 안정적으로 동작한다.
//
// 따라서 이 모듈은:
//  1) RULE_LOOKUP: 사람이 브라우저에서 직접 확인한 규정명 -> bookid 매핑표
//  2) fetchRuleFullText(bookid): 매 호출마다 신규 세션을 얻어 전문을 가져오는 함수
// 로 구성한다. 매핑표에 없는 규정은 지원 불가로 명시적으로 안내한다.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 2026.7 기준, 브라우저 개발자도구(Network 탭)에서 직접 확인한 bookid.
// rule.krx.co.kr의 검색/트리 API가 막혀 있어 이 목록은 수동으로만 확장 가능하다.
// 새 규정이 필요하면: rule.krx.co.kr 접속 -> KRX규정 메뉴 -> 해당 규정 클릭 ->
// F12 개발자도구 Network 탭에서 regulationViewPop.do 요청의 bookid 파라미터 확인.
export const RULE_LOOKUP = {
  "코스닥시장 상장규정": { bookid: "210220591", market: "코스닥시장" },
  "코스닥시장 상장규정 시행세칙": { bookid: "210222109", market: "코스닥시장" },
  "유가증권시장 상장규정": { bookid: "210220143", market: "유가증권시장" },
  "유가증권시장 상장규정 시행세칙": { bookid: "210222644", market: "유가증권시장" },
  "코넥스시장 상장규정": { bookid: "210220471", market: "코넥스시장" },
  "코넥스시장 상장규정 시행세칙": { bookid: "210222787", market: "코넥스시장" },
  "코스닥시장 공시규정": { bookid: "210226148", market: "코스닥시장" },
  "코스닥시장 공시규정 시행세칙": { bookid: "210229371", market: "코스닥시장" },
  "유가증권시장 공시규정": { bookid: "210227471", market: "유가증권시장" },
  "유가증권시장 공시규정 시행세칙": { bookid: "210179748", market: "유가증권시장" },
  "코넥스시장 공시규정": { bookid: "210223621", market: "코넥스시장" },
  "코넥스시장 공시규정 시행세칙": { bookid: "210224312", market: "코넥스시장" },
  "유가증권시장 업무규정": { bookid: "210225665", market: "유가증권시장" },
  "유가증권시장 업무규정 시행세칙": { bookid: "210225129", market: "유가증권시장" },
  "코스닥시장 업무규정 시행세칙": { bookid: "210223538", market: "코스닥시장" },
  "코넥스시장 업무규정 시행세칙": { bookid: "210224651", market: "코넥스시장" },
  "코스닥시장 상장적격성 실질심사지침": { bookid: "210088759", market: "코스닥시장" },
  "유가증권시장 상장적격성 실질심사지침": { bookid: "210128148", market: "유가증권시장" },
  "코넥스시장 상장적격성 실질심사지침": { bookid: "210212163", market: "코넥스시장" },
  "코넥스시장 상장심사지침": { bookid: "204847662", market: "코넥스시장" },
  "파생상품시장 업무규정 시행세칙": { bookid: "210228709", market: "파생상품시장" },
};

// 정규화(공백 제거) 후 매핑표에서 가장 잘 맞는 항목을 찾는다.
const normalize = (s) => (s ? s.replace(/\s+/g, "").replace(/\u3000/g, "") : "");

export function findRuleEntry(ruleName) {
  const nameNorm = normalize(ruleName);
  // 완전 일치 우선
  for (const [name, entry] of Object.entries(RULE_LOOKUP)) {
    if (normalize(name) === nameNorm) return { name, ...entry };
  }
  // 부분 일치(포함 관계) 차선
  const partial = Object.entries(RULE_LOOKUP).filter(
    ([name]) => normalize(name).includes(nameNorm) || nameNorm.includes(normalize(name))
  );
  if (partial.length === 1) return { name: partial[0][0], ...partial[0][1] };
  if (partial.length > 1) return { multiple: partial.map(([name, v]) => ({ name, ...v })) };
  return null;
}

async function getSession() {
  const res = await fetch("https://rule.krx.co.kr/", {
    redirect: "follow",
    headers: { "User-Agent": UA },
  });
  const html = await res.text();
  const csrfMatch = html.match(/id="_csrf" name="_csrf" content="([^"]+)"/);
  const csrf = csrfMatch ? csrfMatch[1] : null;
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
  const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");
  if (!csrf || !cookieHeader) throw new Error("rule.krx.co.kr 세션/CSRF 토큰 획득 실패");
  return { csrf, cookieHeader };
}

// HTML에서 사람이 읽을 본문 텍스트만 뽑아낸다 (ExtJS/스크립트 태그 등 잡음 제거).
function extractReadableText(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  cleaned = cleaned
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  cleaned = cleaned.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  return cleaned;
}

export async function fetchRuleFullText(bookid) {
  const session = await getSession();
  const body = new URLSearchParams({ bookid, noformyn: "N", _csrf: session.csrf });
  const res = await fetch("https://rule.krx.co.kr/out/regulation/regulationViewPop.do", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: session.cookieHeader,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`rule.krx.co.kr 응답 오류: HTTP ${res.status}`);
  const html = await res.text();
  const text = extractReadableText(html);
  // ExtJS 부트스트랩 스크립트 + 개정연혁 목록이 앞에 섞여 들어오므로,
  // 실제 본칙이 시작되는 "제1조(...)" 지점부터 반환한다. 단, 부칙 블록 안에서
  // "제1조"가 인용되는 경우(예: "제1조부터 제N조까지")는 건너뛴다.
  const re = /제\s*1\s*조\s*\([^)]*\)/g;
  let m;
  let startIdx = -1;
  while ((m = re.exec(text)) !== null) {
    const precedingWindow = text.slice(Math.max(0, m.index - 60), m.index);
    if (precedingWindow.includes("부칙")) continue;
    startIdx = m.index;
    break;
  }
  return startIdx > 0 ? text.slice(startIdx - 200 > 0 ? startIdx - 200 : 0) : text;
}

// 특정 조번호만 추출 (예: "제28조"). 못 찾으면 null.
//
// 주의: KRX 규정 원문에는 각 개정 이력마다 "부칙 <제OOOO호, ...>" 블록이 반복적으로
// 등장하고, 그 안에 "제10조(다른 규정의 개정)"처럼 "다른 규정의 특정 조문을 이렇게
// 고친다"는 식의 문구가 들어있어 본문 조번호와 겹칠 수 있다. 이런 부칙 내 인용은
// 실제 해당 조문 본문이 아니므로, 매치 직전 텍스트에 "부칙"이 가깝게 나오면 건너뛴다.
export function extractArticle(fullText, articleNo) {
  if (!articleNo) return null;
  const escaped = articleNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "\\s*\\([^)]*\\)", "g");
  const nextRe = /제\s*\d+\s*조(?:의\s*\d+)?\s*\(/g;

  const candidates = [];
  let m;
  while ((m = re.exec(fullText)) !== null) {
    const precedingWindow = fullText.slice(Math.max(0, m.index - 150), m.index);
    const isInBuchik = precedingWindow.includes("부칙");
    const start = m.index;
    nextRe.lastIndex = start + m[0].length;
    const nextMatch = nextRe.exec(fullText);
    const end = nextMatch ? nextMatch.index : Math.min(fullText.length, start + 4000);
    const content = fullText.slice(start, end).trim();
    const isDeleted = /^\s*제\s*\d+\s*조(?:의\s*\d+)?\s*\(?\s*삭제\s*\)?/.test(content);
    candidates.push({ isInBuchik, isDeleted, content });
  }

  // 우선순위: 부칙도 아니고 삭제도 아닌 것 > 삭제된 것(그 사실을 알려줌) > 부칙 내 인용
  const real = candidates.find((c) => !c.isInBuchik && !c.isDeleted);
  if (real) return real.content;
  const deleted = candidates.find((c) => !c.isInBuchik && c.isDeleted);
  if (deleted) return deleted.content; // "(삭제)"임을 그대로 보여줌
  return candidates.length ? candidates[0].content : null;
}
