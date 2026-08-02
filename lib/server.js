import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RULE_LOOKUP, findRuleEntry, fetchRuleFullText, extractArticle } from "./rule_krx_client.js";

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

// 별표·별지·서식 번호가 article_no로 들어오는 경우를 즉시 감지하기 위한 패턴.
// (실제 사고 2026-08-02: "별표9"/"별표 9"를 article_no에 그대로 넣었다가 조문 조회
//  실패 fallback을 "존재하지 않는다"로 오인한 사례가 있었음. get_krx_rule_fulltext는
//  rule.krx.co.kr의 조문(제N조) 본문만 가져오는 구조라 별표·별지·서식은 애초에
//  포함되지 않는다 — 이건 버그가 아니라 이 API의 구조적 한계이므로, 실패 메시지 대신
//  올바른 조회 경로(krx_listing_disclosure)를 바로 안내한다.)
const ANNEX_PATTERN = /별표|별지|서식|부표|첨부/;

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

  // rule.krx.co.kr(KRX 법무포털)에서 실시간으로 조문 원문을 가져온다.
  // 검색/트리 API는 막혀 있어(2026.7 확인) RULE_LOOKUP 매핑표에 등록된 규정만 지원한다.
  server.tool(
    "get_krx_rule_fulltext",
    "상장규정·공시규정·업무규정·상장적격성 실질심사지침의 완전한 법정 조문(제N조) 원문을 " +
      "rule.krx.co.kr(KRX 법무포털)에서 실시간으로 조회합니다. 매번 최신 개정본을 가져오며, " +
      "응답 맨 앞에 '제N차 일부개정 YYYY.MM.DD' 개정이력이 포함되어 있으니 반드시 이를 확인해 " +
      "몇 차 개정본인지 답변에 명시하세요. 사전에 등록된 규정명 목록에서만 조회 가능하며, " +
      "목록에 없는 규정은 search_krx_regulation으로 대체 안내합니다. " +
      "⚠️ 이 도구는 '제N조' 형태의 조문 본문만 반환하며, 조문이 인용하는 [별표]·[별지]·[서식] " +
      "내용(지정·해제 시기표, 벌점 배점표, 제재금 산정식, 요건 요약표 등 실제 수치가 담긴 " +
      "첨부자료)은 구조적으로 포함하지 않습니다. 별표·별지·서식 관련 질문은 이 도구만으로 " +
      "답하지 말고, PDF Vector DB MCP 서버의 krx_listing_disclosure 컬렉션(search_book_library)을 " +
      "반드시 함께 조회하세요.",
    {
      rule_name: z.string().describe("규정명 (예: '코스닥시장 상장규정', '유가증권시장 공시규정')"),
      article_no: z
        .string()
        .optional()
        .describe(
          "조문 번호 (예: '제28조'). 별표·별지·서식 번호(예: '별표9')는 이 파라미터로 조회되지 " +
            "않습니다 — PDF Vector DB krx_listing_disclosure 컬렉션에서 조회하세요."
        ),
    },
    async ({ rule_name, article_no }) => {
      const entry = findRuleEntry(rule_name);

      if (!entry) {
        const nameNorm = normalize(rule_name);
        const hint = PAGES.filter(
          (p) => p._titleNorm.includes(nameNorm) || p._bodyNorm.includes(nameNorm)
        ).slice(0, 5);
        const supported = Object.keys(RULE_LOOKUP).join(", ");
        const text =
          `"${rule_name}"은(는) 현재 조문 원문 지원 목록에 없습니다.\n` +
          `지원 목록: ${supported}\n\n` +
          (hint.length
            ? `대신 참고할 수 있는 관련 해설·요건표(${hint.length}건):\n` +
              JSON.stringify(hint.map((p) => ({ page_name: p.page_name, url: p.url })), null, 2)
            : "관련 해설 자료도 찾지 못했습니다.");
        return { content: [{ type: "text", text }] };
      }

      if (entry.multiple) {
        const text =
          `"${rule_name}"에 해당할 수 있는 규정이 여러 건입니다. 정확한 명칭으로 다시 요청하세요:\n` +
          entry.multiple.map((e) => `- ${e.name}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      // 별표·별지·서식 번호를 article_no에 넣은 경우, 조문 조회를 시도하기도 전에
      // 즉시 올바른 경로를 안내한다. (2026-08-02 사고 재발 방지용 — 이 분기가 없으면
      // 아래 "찾지 못했습니다" fallback으로 빠져서 "존재하지 않는다"로 오인하기 쉽다.)
      if (article_no && ANNEX_PATTERN.test(article_no)) {
        return {
          content: [
            {
              type: "text",
              text:
                `"${article_no}"는 별표·별지·서식으로 보입니다. 이 도구(get_krx_rule_fulltext)는 ` +
                `'제N조' 형태의 조문 본문만 rule.krx.co.kr에서 조회하며, 별표·별지·서식 내용은 ` +
                `구조적으로 포함하지 않습니다(전문 목차에 제목만 나열되고 실제 표 내용은 없음).\n\n` +
                `→ 별표·서식의 실제 내용(수치·기간·산정식 등)은 PDF Vector DB MCP 서버의 ` +
                `krx_listing_disclosure 컬렉션에서 조회하세요:\n` +
                `search_book_library(collection="krx_listing_disclosure", query="${rule_name} ${article_no}")\n\n` +
                `이 컬렉션에서도 결과가 없거나 잘려 보이면, Qdrant Cloud REST API로 직접 scroll ` +
                `조회(doc_title 필터)하여 전체 청크를 확인하세요.`,
            },
          ],
        };
      }

      try {
        const fullText = await fetchRuleFullText(entry.bookid);
        if (article_no) {
          const article = extractArticle(fullText, article_no);
          if (article) {
            return {
              content: [
                {
                  type: "text",
                  text: `[${entry.name}] ${article_no} (rule.krx.co.kr bookid=${entry.bookid} 실시간 조회)\n\n${article}`,
                },
              ],
            };
          }
          // 조문을 못 찾으면 전문 앞부분(개정이력 포함)과 함께 안내.
          return {
            content: [
              {
                type: "text",
                text:
                  `[${entry.name}]에서 "${article_no}"를 찾지 못했습니다. 전문 앞부분을 표시합니다:\n\n` +
                  fullText.slice(0, 2000) +
                  `\n\n(참고: 이 도구는 [별표]·[별지]·[서식] 내용은 조회하지 못합니다. 찾으시는 ` +
                  `내용이 별표·서식에 해당한다면 PDF Vector DB krx_listing_disclosure 컬렉션을 ` +
                  `확인하세요.)`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `[${entry.name}] 전문 (rule.krx.co.kr bookid=${entry.bookid} 실시간 조회)\n\n${fullText}`,
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `rule.krx.co.kr 실시간 조회 중 오류가 발생했습니다: ${e.message}\n` +
                `잠시 후 다시 시도하거나 search_krx_regulation으로 대체 확인하세요.`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

export const PAGE_COUNT = PAGES.length;
