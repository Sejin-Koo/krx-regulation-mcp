# KRX Regulation MCP Server

KRX(한국거래소) 상장규정·공시규정·매매거래제도 등 규정 **해설 페이지 254건**
(regulation.krx.co.kr 194건 + listing.krx.co.kr 60건)을 검색·조회하는 MCP 서버입니다.

기존에 쓰고 계신 DART MCP / DCF Peer Group MCP와 동일한 방식(Vercel 배포,
`/api/mcp`에 JSON-RPC 2.0 POST)으로 만들었습니다.

## ⚠️ 커버리지 한계 (중요)

이 서버는 **KRX가 공식 게시한 "제도 해설 + 상장요건표 + 조문번호 인용"**을 다룹니다.
법정 상장규정·공시규정의 **완전한 조문 원문 그 자체**는 아직 포함되어 있지 않습니다
(원문은 `rule.krx.co.kr`에 있으나 CSRF/WAF로 보호되어 현재 접근 불가).

`get_krx_rule_fulltext` 도구는 이런 상황을 감안해 **스텁(stub)**으로 미리 만들어
두었습니다 — 이름과 파라미터는 지금 확정되어 있으므로, 나중에 rule.krx.co.kr
접근이 가능해지면 `lib/server.js`의 해당 도구 내부 구현만 교체하면 됩니다
(MCP 클라이언트 쪽 재연결·재등록 불필요).

## 제공 도구 (3개)

1. **search_krx_regulation** — keyword/market/category로 검색 (market: 유가증권시장·코스닥시장·코넥스시장·공통)
2. **get_krx_regulation_page** — url 또는 page_name으로 특정 페이지 전체 본문 조회
3. **get_krx_rule_fulltext** — [준비중] 완전한 법정 조문 원문 (현재는 안내 메시지 + 관련 해설 힌트 반환)

## 로컬 테스트 (배포 전 확인용)

```bash
npm install
npm run dev:test
```

인메모리 트랜스포트로 실제 MCP 클라이언트-서버 통신을 시뮬레이션해서
3개 도구가 정상 동작하는지 확인합니다. (이미 검증 완료된 상태로 드립니다.)

## Vercel 배포

```bash
npm install -g vercel   # 최초 1회
cd krx-regulation-mcp
vercel login
vercel --prod
```

배포되면 `https://<프로젝트명>.vercel.app/api/mcp` 형태의 URL이 나옵니다.
기존 DART MCP·DCF MCP와 마찬가지로 인증 없이 바로 호출 가능합니다.

## 배포 후 curl로 직접 확인 (claude.ai tool_search가 못 잡을 경우 대비)

⚠️ **StreamableHTTP 프로토콜 특성상 `Accept: application/json, text/event-stream` 헤더가 반드시 필요합니다.** 이게 없으면 `Not Acceptable` 에러가 납니다.

```bash
# 도구 목록 확인
curl -X POST https://krx-regulation-mcp.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 검색 실행 예시
curl -X POST https://krx-regulation-mcp.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_krx_regulation","arguments":{"keyword":"우회상장"}}}'
```

응답은 `event: message\ndata: {...}` 형태의 SSE(Server-Sent Events) 스트림으로 옵니다 — `data:` 뒤의 JSON이 실제 결과입니다.

## claude.ai에 연결하기

claude.ai 설정 > 커넥터(Connectors)에서 배포된 URL(`https://<프로젝트명>.vercel.app/api/mcp`)을
Custom MCP 서버로 추가하시면 됩니다. (DCF Peer Group MCP처럼 claude.ai의 tool_search가
바로 못 잡으면, 기존에 하시던 대로 bash_tool의 curl JSON-RPC 직접 호출 방식으로도
동일하게 쓸 수 있습니다.)

## 데이터 갱신 (유지보수)

`data/krx_pages.json`은 2026년 7월 17일 기준 크롤링 스냅샷입니다.
KRX가 페이지를 개정하면(예: "(2024.1.1. 개정규정 기준)" 같은 버전 표기가 바뀌면)
재크롤링이 필요합니다.

### 자동화: GitHub Actions로 매주 재크롤링 + 자동 재배포

`.github/workflows/recrawl.yml`이 매주 월요일(한국시간 14:00) 자동으로:
1. 사이트맵 재수집 → 전체 페이지 재크롤링 → 재분류
2. 이전 데이터와 다르면 자동 git commit + push
3. Vercel이 GitHub push를 감지해서 **자동 재배포**

이 방식은 로컬 PC(집/회사 노트북)가 켜져 있는지와 무관하게 GitHub 클라우드에서
동작합니다. 최초 설정 방법은 아래 "GitHub 저장소 연결 및 자동배포 설정" 참고.

수동으로 즉시 재크롤링하고 싶으면 GitHub 저장소의 Actions 탭에서
"KRX 규정 재크롤링 및 자동 배포" 워크플로우를 열고 "Run workflow" 버튼을 누르면 됩니다.

## GitHub 저장소 연결 및 자동배포 설정 (최초 1회)

현재 이 프로젝트는 Vercel CLI로 직접 배포되어 있고 GitHub에는 연결되어 있지 않습니다.
아래 순서로 GitHub 연동으로 전환하면, 이후엔 노트북 종류(집/회사)에 상관없이
자동 재배포가 동작합니다.

### 1. GitHub 저장소 생성 및 푸시 (지금 쓰고 있는 노트북에서)

```bash
cd krx-regulation-mcp
git init
git add .
git commit -m "initial commit"
```

GitHub에서 새 저장소(예: `koo3/krx-regulation-mcp`)를 만든 뒤:

```bash
git remote add origin https://github.com/<본인계정>/krx-regulation-mcp.git
git branch -M main
git push -u origin main
```

### 2. Vercel 프로젝트를 GitHub 연동으로 전환

Vercel 대시보드 → 해당 프로젝트(`krx-regulation-mcp`) → **Settings > Git** →
"Connect Git Repository"에서 방금 만든 GitHub 저장소를 연결합니다.
이후로는 `main` 브랜치에 push될 때마다 Vercel이 자동으로 재배포합니다
(더 이상 `vercel --prod`를 수동으로 실행할 필요 없음).

### 3. 확인

GitHub 저장소의 **Actions 탭**에서 "KRX 규정 재크롤링 및 자동 배포" 워크플로우가
보이면 정상 설정된 것입니다. 우측의 "Run workflow"로 수동 테스트 실행도 가능합니다.

## 프로젝트 구조

```
krx-regulation-mcp/
├── api/mcp.js          # Vercel 서버리스 함수 (MCP HTTP 엔드포인트)
├── lib/server.js        # MCP 서버 본체 (도구 3개 정의)
├── data/krx_pages.json  # 크롤링된 254개 페이지 데이터
├── scripts/local_test.js # 로컬 검증 스크립트
├── vercel.json
└── package.json
```
