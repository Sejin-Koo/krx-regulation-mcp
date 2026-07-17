import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataPath = path.join(__dirname, "..", "data", "krx_pages.json");
const PAGES = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

// 검색어/본문의 띄어쓰기 차이(예: "투자주의환기종목" vs "투자주의 환기종목")로 인해
// 일치하는 내용을 놓치지 않도록, 모든 공백(일반 스페이스·탭·개행·전각 공백 등)을 제거한
// 정규화 버전을 별도로 만들어 비교한다. 원본 title/body는 스니펫 등 표시용으로 그대로 둔다.
const normalize = (s) => (s ? s.replace(/\s+/g, "").replace(/\u3000/g, "") : "");

for (const p of PAGES) {
  p._titleNorm = normalize(p.title);
  p._bodyNorm = normalize(p.body);
}

const MARKETS = ["유가증권시장", "코스닥시장", "코넥스시장", "공통"];

export function buildServer() {
  const server = new McpServer({ name: "krx-regulation-mcp", version: "1.0.0" });

  server.tool(
    "search_krx_regulation",
    "KRX(한국거래소) 상장규정·공시규정·매매거래제도·청산결제제도 등 규정 해설 페이지를 검색합니다. " +
      "출처: regulation.krx.co.kr(제도해설) + listing.krx.co.kr(상장요건). " +
      "주의: 이 서버는 법정 조문 '원문'이 아니라 KRX가 공식 게시한 '제도 해설·요건표·조문 인용'을 다룹니다. " +
      "완전한 조문 원문이 필요하면 get_krx_rule_fulltext를 먼저 시도하고, 실패 시 이 결과를 참고자료로 안내하세요.",
    {
      keyword: z.string().optional().describe("검색 키워드 (예: '우회상장', '단기과열', '관리종목')"),
      market: z.enum(MARKETS).optional().describe("시장 구분"),
      category: z.string().optional().describe("대분류 예: 주권상장, 공시제도, 매매거래제도, 청산결제제도, SPAC상장 등"),
      limit: z.number().int().min(1).max(50).optional().describe("최대 결과 수 (기본 10)"),
    },
    async ({ keyword, market, category, limit }) => {
      let results = PAGES;
      if (market) results = results.filter((p) => p.market === market);
      if (category) results = results.filter((p) => p.category_l1 && p.category_l1.includes(category));
      if (keyword) {
        const kwNorm = normalize(keyword);
        results = results.filter(
          (p) => p._titleNorm.includes(kwNorm) || p._bodyNorm.includes(kwNorm)
        );
      }
      const total = results.length;
      results = results.slice(0, limit || 10);
      const summary = results.map((p) => ({
        page_name: p.page_name,
        market: p.market,
        category: p.category_l1,
        url: p.url,
        snippet: p.body ? p.body.slice(0, 200) : "",
      }));
      const text =
        total === 0
          ? "검색 결과가 없습니다. 키워드를 더 넓게 시도하거나 category/market 필터를 제거해보세요."
          : `총 ${total}건 중 ${summary.length}건 표시\n\n` + JSON.stringify(summary, null, 2);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "get_krx_regulation_page",
    "URL 또는 page_name으로 KRX 규정 해설 페이지의 전체 본문을 가져옵니다. search_krx_regulation 결과의 url 필드를 그대로 넣으면 됩니다.",
    {
      url: z.string().optional(),
      page_name: z.string().optional(),
    },
    async ({ url, page_name }) => {
      let page = null;
      if (url) page = PAGES.find((p) => p.url === url);
      else if (page_name) page = PAGES.find((p) => p.page_name === page_name);
      if (!page) {
        return {
          content: [
            { type: "text", text: "해당 페이지를 찾을 수 없습니다. search_krx_regulation으로 먼저 url을 확인하세요." },
          ],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(page, null, 2) }] };
    }
  );

  // rule.krx.co.kr(KRX 법무포털)이 뚫리면 이 도구 내부 구현만 교체하면 됨.
  // 인터페이스(이름/파라미터)는 지금 확정해두어 MCP 클라이언트 쪽 재연결이 필요 없도록 함.
  server.tool(
    "get_krx_rule_fulltext",
    "[준비중] 상장규정·공시규정·업무규정의 완전한 법정 조문 원문을 조회합니다. " +
      "현재는 rule.krx.co.kr(KRX 법무포털)이 CSRF/WAF로 보호되어 있어 미지원 상태이며, " +
      "접근 가능해지는 대로 이 도구 내부 구현이 채워질 예정입니다. 지금은 search_krx_regulation으로 대체하세요.",
    {
      rule_name: z.string().describe("규정명 (예: '코스닥시장 상장규정')"),
      article_no: z.string().optional().describe("조문 번호 (예: '제28조')"),
    },
    async ({ rule_name, article_no }) => {
      const nameNorm = normalize(rule_name);
      const hint = PAGES.filter(
        (p) => p._titleNorm.includes(nameNorm) || p._bodyNorm.includes(nameNorm)
      ).slice(0, 5);
      const text =
        `[미지원] "${rule_name}"${article_no ? " " + article_no : ""}의 완전한 조문 원문은 아직 제공되지 않습니다.\n` +
        `rule.krx.co.kr 접근이 열리면 이 기능이 채워질 예정입니다.\n\n` +
        (hint.length
          ? `대신 참고할 수 있는 관련 해설·요건표(${hint.length}건):\n` +
            JSON.stringify(
              hint.map((p) => ({ page_name: p.page_name, url: p.url })),
              null,
              2
            )
          : "관련 해설 자료도 찾지 못했습니다.");
      return { content: [{ type: "text", text }] };
    }
  );

  return server;
}

export const PAGE_COUNT = PAGES.length;
