# KRX Regulation MCP Server

KRX(한국거래소) 상장규정·공시규정·업무규정·상장적격성 실질심사지침의 **조문 원문과 별표**,
그리고 KRX가 공식 게시한 **제도 해설·상장요건표**를 검색·조회하는 MCP 서버입니다.

데이터는 성격이 다른 두 층으로 나뉩니다.

| 층 | 출처 | 방식 | 최신성 |
|---|---|---|---|
| 조문 원문 | `rule.krx.co.kr` (KRX 법무포털) | 호출할 때마다 실시간 조회 | 항상 최신 개정본 |
| 별표 목록·개정일 | 같은 조문 응답 HTML | 조문과 함께 실시간 파싱(추가 요청 없음) | 항상 최신 |
| 별표 본문 | PDF Vector DB MCP 서버의 `krx_listing_disclosure` 컬렉션 | 호출 시 서버 간 조회 | 저장본 기준(개정일 불일치는 경고) |
| 해설·요건표 | `regulation.krx.co.kr`, `listing.krx.co.kr`, KIND 해설서 PDF | 주 1회 크롤링한 정적 데이터(`data/krx_pages.json`) | 최대 1주 시차 |

## 데이터 획득 방식 — 공식 API가 아니라 스크래핑

KRX는 규정 조문·해설에 대한 공식 Open API를 제공하지 않습니다. 이 서버는 두 층 모두
사이트가 브라우저에 내려주는 내용을 직접 가져옵니다. 발급받을 인증키가 없는 대신,
**원본 사이트가 개편되면 사전 공지 없이 동작이 깨질 수 있습니다.**

### 조문 원문 (`lib/rule_krx_client.js`)

1. `https://rule.krx.co.kr/`에 접속해 세션 쿠키와 CSRF 토큰(`_csrf`)을 받습니다.
2. 그 토큰으로 `/out/regulation/regulationViewPop.do`에 `bookid`를 POST합니다.
3. 돌아온 HTML에서 스크립트·태그를 걷어내고, 본칙 `제1조(…)`부터 본문 텍스트를 반환합니다.

사이트의 검색(`outsearch.do`)과 트리 브라우징(`getTreeNode.do`)은 세션·JS 상태 의존이 커서
순수 HTTP로 재현되지 않습니다(2026.7 확인). 그래서 **규정별 `bookid`를 사람이 브라우저에서
확인해 `RULE_LOOKUP` 매핑표에 수동 등록하는 구조**이며, 매핑표에 없는 규정은 조문 원문을
조회할 수 없습니다(2026-09-28 기준 23개 규정 등록).

특정 조문 추출 시에는 개정 부칙 블록 안의 "제N조(다른 규정의 개정)" 같은 인용을 본문으로
오인하지 않도록 걸러내고, 삭제된 조문은 "(삭제)" 상태를 그대로 보여줍니다.

### 해설·요건표 (`scripts/`)

| 소스 | 수집 스크립트 | 건수(2026-09-28 기준) |
|---|---|---:|
| regulation.krx.co.kr 제도해설 | `crawl_krx.py` (URL 목록: `rgl_urls.txt`) | 188 |
| listing.krx.co.kr 상장요건표 | `crawl_krx.py` (URL 목록: `lst_urls.txt`) | 60 |
| KIND 「코스닥시장 공시·상장관리 해설」 PDF | `crawl_kind_pdf.py` (소스 목록: `kind_pdf_sources.txt`) | 406 (페이지 단위) |
| 합계 | `reclassify.py`로 시장·분류 태깅 후 병합 | 654 |

해설 페이지에 없는 상장관리업무 세부 지정요건(투자주의환기종목 정기지정 통계모형 변수·가중치,
관리종목·실질심사 세부 기준표 등)은 KIND 해설서 PDF에서 페이지 단위로 추출해 보완합니다.
건수는 주간 재크롤링 결과에 따라 달라지며, 실제 값은 `scripts/local_test.js` 실행 시 첫 줄에
출력됩니다.

## 제공 도구 (3개)

| 도구 | 기능 | 데이터 층 |
|---|---|---|
| `search_krx_regulation` | keyword·market·category로 해설·요건표 검색. 띄어쓰기 차이를 무시하고 매칭 | 해설(정적) |
| `get_krx_regulation_page` | `url` 또는 `page_name`으로 해설 페이지 전체 본문 조회 | 해설(정적) |
| `get_krx_rule_fulltext` | `rule_name`(+선택 `article_no`)으로 조문 원문 실시간 조회. 응답 앞에 "제N차 일부개정 YYYY.MM.DD" 개정이력 포함. 조문이 인용한 별표를 뒤에 붙이고, `article_no`에 "별표10"을 넣으면 그 별표를 조회 | 조문(실시간) + 별표 |

`market` 값: `유가증권시장` / `코스닥시장` / `코넥스시장` / `공통`

## 알려진 제약

- **별표 본문은 KRX 원본이 아니라 벡터DB 저장본입니다.** 원본은 HWP 첨부라 이 서버가 직접
  받지 않습니다. KRX 목록의 개정일과 저장본의 개정일 표기가 다르면 응답에 경고를 붙이며,
  이때 KRX 목록(실시간)이 현행 기준입니다. 저장본에 없는 별표는 본문 없이 목록 정보만 나갑니다.
- **별지·서식(신청서 양식)은 목록만 제공합니다.**
- **`RULE_LOOKUP`에 없는 규정은 조문 원문 미지원.** 이 경우 관련 해설 페이지를 대신 안내합니다.
- **규정 제·개정예고(미시행 초안)는 조회 불가.** 별도 게시판 시스템이라 이 서버의 범위 밖입니다.
- **`law.krx.co.kr`은 공식 폐지되어 사용하지 않습니다.** 조문 원문의 유효한 출처는
  `rule.krx.co.kr`뿐입니다.
- KRX **시세** 데이터(`data-dbg.krx.co.kr`)는 별개의 공식 API입니다. 인증키(AUTH_KEY)는 이미 발급받아
  별도로 보관하고 있으며, 이 서버는 시세 API를 사용하지 않습니다.

## 별표 조회 (`lib/annex.js`)

| 호출 | 결과 |
|---|---|
| `article_no: "제58조"` | 조문 원문 + 그 조문이 인용한 별표(최대 3건)의 제목·개정일·본문 |
| `article_no: "별표10"` | 그 별표의 제목·개정일·본문 |
| `article_no` 생략 | 전문 앞에 그 규정의 별표 목록(제목·개정일) |

- 지정·해제 시기표, 벌점 배점표, 제재금 산정기준 같은 별표는 대부분 **시행세칙**에 있습니다
  (예: 코스닥시장 상장규정 시행세칙 별표10, 코스닥시장 공시규정 시행세칙 별표1).
- 별표 목록과 KRX 개정일은 조문을 가져올 때 받는 같은 HTML에서 뽑습니다. 본문 끝의
  `p.byulText`에 개정일이 붙어 있고, "별표 및 서식" 목록의 `p.attachText`에는 제목만 있습니다.
- 본문은 PDF Vector DB MCP 서버의 `get_chunk_text`로 가져옵니다. 이때 **호출자가 이 서버에 쓴
  게이트키를 그대로 전달**하므로 별도 환경변수가 필요 없습니다. 그 키가 PDF Vector DB 서버에
  등록돼 있지 않으면 본문 대신 직접 조회할 호출 예시를 안내합니다. 엔드포인트를 바꾸려면
  `PDF_DB_MCP_ENDPOINT` 환경변수를 씁니다.
- 문서명 대조는 "규정명 바로 뒤에 그 별표 번호"로 합니다. 그래서 "코스닥시장 상장규정"이
  시행세칙 문서에, "별표1"이 "별표10"에 걸리지 않습니다.

## 새 규정 추가 (수작업)

1. 브라우저로 `rule.krx.co.kr` 접속 → KRX규정 메뉴 → 추가할 규정 클릭
2. F12 개발자도구 Network 탭에서 `regulationViewPop.do` 요청의 `bookid` 파라미터 확인
3. `lib/rule_krx_client.js`의 `RULE_LOOKUP`에 `"규정명": { bookid: "…", market: "…" }` 추가
4. `main`에 push → Vercel 자동 재배포

사이트의 검색·트리 API가 자동화되지 않으므로 이 단계는 사람이 직접 해야 합니다.

## 접근 게이트

엔드포인트 주소만으로 누구나 호출하는 것을 막기 위해, 호출자는 발급받은 게이트키를
쿼리스트링으로 전달합니다.

```
https://krx-regulation-mcp.vercel.app/api/mcp?k=<발급키>
```

| 환경변수 | 의미 |
|---|---|
| `MCP_GATE_KEYS` | 허용 키 목록(쉼표 구분). **비어 있으면 게이트 비활성**(모두 통과) |
| `MCP_GATE_MODE` | `enforce`면 키가 없거나 목록에 없을 때 401 차단. 그 밖(기본 `observe`)이면 통과시키되 로그만 남김 |

로그에는 키 전문 대신 발급 대상 식별자만 남습니다. 키 값은 이 저장소에 두지 않으며,
발급·차단 절차는 별도 운영 문서에서 관리합니다.

## 직접 호출 (curl)

StreamableHTTP 규격상 `Accept: application/json, text/event-stream` 헤더가 필수입니다
(없으면 `Not Acceptable`). 응답은 `event: message` / `data: {...}` 형태의 SSE이며,
`data:` 뒤의 JSON이 실제 결과입니다.

```bash
# 도구 목록
curl -X POST "https://krx-regulation-mcp.vercel.app/api/mcp?k=<발급키>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 조문 원문 실시간 조회
curl -X POST "https://krx-regulation-mcp.vercel.app/api/mcp?k=<발급키>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_krx_rule_fulltext","arguments":{"rule_name":"코스닥시장 상장규정","article_no":"제28조"}}}'
```

claude.ai에서는 설정 > 커넥터에 게이트키가 포함된 위 주소를 커스텀 MCP 서버로 등록해 사용합니다.

## 데이터 갱신 자동화 (GitHub Actions)

`.github/workflows/recrawl.yml`이 **매주 월요일 02:00 KST**(일요일 17:00 UTC)에 자동 실행됩니다.
Actions 탭 "KRX 규정 재크롤링 및 자동 배포" → "Run workflow"로 수동 실행도 가능합니다.

1. 사이트맵 재수집으로 URL 목록 갱신 — 실패해도 저장소의 기존 URL 목록으로 계속 진행
2. 해설 페이지 전체 재크롤링 (`crawl_krx.py`)
3. KIND 해설서 PDF 크롤링 (`crawl_kind_pdf.py`)
4. 재분류 후 `data/krx_pages.json` 생성 — 앞 단계가 중간에 끊겨도 수집된 만큼으로 진행
5. 변경이 있을 때만 자동 커밋·푸시 → Vercel이 push를 감지해 자동 재배포

조문 원문 층은 매 호출 실시간 조회이므로 이 워크플로의 대상이 아닙니다.

## 배포

GitHub `main` 브랜치에 push하면 Vercel이 자동 재배포합니다. 로컬 PC 상태와 무관하게
GitHub·Vercel 클라우드에서 동작합니다. `vercel.json`은 서버리스 함수에 `data/**`를
포함시키고 최대 실행시간을 30초로 설정합니다.

## 로컬 테스트

```bash
npm install
npm run dev:test
```

인메모리 트랜스포트로 클라이언트-서버 통신을 시뮬레이션해 데이터 건수, `tools/list`,
`search_krx_regulation`, `get_krx_rule_fulltext`(실제 rule.krx.co.kr 호출) 동작을 확인합니다.

## 프로젝트 구조

```
krx-regulation-mcp/
├── api/mcp.js                   # Vercel 서버리스 엔드포인트 (접근 게이트 포함)
├── lib/
│   ├── server.js                # MCP 서버 본체 (도구 3개)
│   ├── rule_krx_client.js       # rule.krx.co.kr 실시간 조문 조회 + RULE_LOOKUP 매핑표
│   └── annex.js                 # 별표 목록 파싱 + PDF Vector DB 사본 조회
├── data/
│   ├── krx_pages.json           # 서버가 읽는 병합본 (해설 + KIND PDF)
│   ├── krx_pages_final.jsonl    # 해설 페이지 재분류 결과
│   └── kind_pdf_pages.jsonl     # KIND 해설서 PDF 페이지 추출 결과
├── scripts/
│   ├── crawl_krx.py             # 해설 페이지 크롤러
│   ├── crawl_kind_pdf.py        # KIND PDF 크롤러
│   ├── reclassify.py            # 시장·분류 태깅
│   ├── check_dead_urls.py       # 해설 URL 생존 점검 (법무포털 이관·폐지 판별)
│   ├── rgl_urls.txt / lst_urls.txt / kind_pdf_sources.txt   # 수집 대상 목록
│   └── local_test.js            # 로컬 검증 스크립트
├── .github/workflows/recrawl.yml
├── vercel.json
└── package.json
```
