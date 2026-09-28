import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { RULE_LOOKUP, findRuleEntry, fetchRuleHtml, htmlToRuleText, extractArticle } from "./rule_krx_client.js";
import { annexKey, parseAnnexList, referencedAnnexKeys, renderAnnex, renderAnnexList } from "./annex.js";

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

// 별표·별지·서식 번호가 article_no로 들어오는 경우를 감지하는 패턴.
// 조문 원문(HTML 본문)에는 별표 표 내용이 없으므로, 이 경우 조문 추출을 시도하지 않고
// 별표 목록에서 해당 항목을 찾아 PDF Vector DB 사본의 본문을 돌려준다(lib/annex.js).
// (2026-08-02 사고: "별표9"를 조문으로 찾다 실패한 결과를 "존재하지 않는다"로 오인한 적이 있다.)
const ANNEX_PATTERN = /별표|별지|서식|부표|첨부/;

export function buildServer(ctx = {}) {
  const gateKey = ctx.gateKey || null; // 별표 본문을 PDF Vector DB에서 가져올 때 쓰는 호출자 키
  const server = new McpServer({ name: "krx-regulation-mcp", version: "1.1.0" });

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

  // rule.krx.co.kr(KRX 법무포털)에서 실시간으로 조문 원문을 가져오고, 조문이 인용하는 별표를 함께 붙인다.
  // 검색/트리 API는 막혀 있어(2026.7 확인) RULE_LOOKUP 매핑표에 등록된 규정만 지원한다.
  // 별표 목록·개정일은 같은 응답 HTML에서, 별표 본문은 PDF Vector DB 사본에서 가져온다(lib/annex.js).
  server.tool(
    "get_krx_rule_fulltext",
    "상장규정·공시규정·업무규정·상장적격성 실질심사지침의 완전한 법정 조문(제N조) 원문을 " +
      "rule.krx.co.kr(KRX 법무포털)에서 실시간으로 조회합니다. 매번 최신 개정본을 가져오며, " +
      "응답 맨 앞에 '제N차 일부개정 YYYY.MM.DD' 개정이력이 포함되어 있으니 반드시 이를 확인해 " +
      "몇 차 개정본인지 답변에 명시하세요. 사전에 등록된 규정명 목록에서만 조회 가능하며, " +
      "목록에 없는 규정은 search_krx_regulation으로 대체 안내합니다. " +
      "별표도 함께 다룹니다: ①조문을 조회하면 그 조문이 인용하는 [별표]의 제목·KRX 개정일과 본문을 " +
      "응답 끝에 붙이고, ②article_no에 '별표10'처럼 별표 번호를 넣으면 그 별표를 조회하며, " +
      "③article_no 없이 조회하면 그 규정의 별표 목록(제목·개정일)을 앞에 붙입니다. " +
      "지정·해제 시기표, 벌점 배점표, 제재금 산정기준 같은 별표는 대부분 '시행세칙'에 있으므로 " +
      "(예: 코스닥시장 상장규정 시행세칙 별표10, 코스닥시장 공시규정 시행세칙 별표1) 시행세칙을 조회하세요. " +
      "별표 본문은 KRX 원본 HWP가 아니라 PDF Vector DB(krx_listing_disclosure)에 저장된 사본이며, " +
      "KRX 목록의 개정일과 저장본의 개정일이 다르면 응답에 경고로 표시합니다 — 그 경우 답변에 밝히세요. " +
      "별지·서식(신청서 양식)은 목록만 제공합니다.",
    {
      rule_name: z.string().describe("규정명 (예: '코스닥시장 상장규정', '코스닥시장 상장규정 시행세칙')"),
      article_no: z
        .string()
        .optional()
        .describe(
          "조문 번호(예: '제28조') 또는 별표 번호(예: '별표10', '별표 2의2'). " +
            "생략하면 전문과 별표 목록을 반환합니다."
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

      try {
        const html = await fetchRuleHtml(entry.bookid);
        const fullText = htmlToRuleText(html);
        const annexes = parseAnnexList(html);
        const src = `rule.krx.co.kr bookid=${entry.bookid} 실시간 조회`;

        // ② 별표·별지·서식 번호를 받은 경우
        if (article_no && ANNEX_PATTERN.test(article_no)) {
          const key = annexKey(article_no);
          const annex = key ? annexes.find((a) => a.key === key) : null;
          if (!annex) {
            const list = renderAnnexList(annexes);
            return {
              content: [
                {
                  type: "text",
                  text:
                    `[${entry.name}]에서 "${article_no}"를 찾지 못했습니다. ` +
                    (key
                      ? "번호를 확인하세요. 별표는 대부분 시행세칙에 있습니다."
                      : "별지·서식(신청서 양식)은 목록만 제공합니다.") +
                    (list ? `\n\n${list}` : "\n\n이 규정에는 KRX 법무포털에 등록된 별표가 없습니다."),
                },
              ],
            };
          }
          const block = await renderAnnex(gateKey, entry.name, annex);
          return { content: [{ type: "text", text: `[${entry.name}] ${annex.kind} (${src})\n\n${block}` }] };
        }

        // ① 조문 조회 — 인용된 별표를 뒤에 붙인다(최대 3건)
        if (article_no) {
          const article = extractArticle(fullText, article_no);
          if (article) {
            const keys = referencedAnnexKeys(article).slice(0, 3);
            const found = keys.map((k) => annexes.find((a) => a.key === k)).filter(Boolean);
            const blocks = await Promise.all(found.map((a) => renderAnnex(gateKey, entry.name, a)));
            const missing = keys.filter((k) => !annexes.some((a) => a.key === k));
            let tail = "";
            if (blocks.length) tail += `\n\n── 이 조문이 인용하는 별표 ──\n\n${blocks.join("\n\n")}`;
            if (missing.length)
              tail +=
                `\n\n(조문이 인용한 ${missing.join(", ")}은(는) 이 규정의 별표 목록에 없습니다. ` +
                `다른 규정(주로 시행세칙)의 별표일 수 있습니다.)`;
            return {
              content: [{ type: "text", text: `[${entry.name}] ${article_no} (${src})\n\n${article}${tail}` }],
            };
          }
          // 조문을 못 찾으면 전문 앞부분(개정이력 포함)과 함께 안내.
          return {
            content: [
              {
                type: "text",
                text:
                  `[${entry.name}]에서 "${article_no}"를 찾지 못했습니다. 전문 앞부분을 표시합니다:\n\n` +
                  fullText.slice(0, 2000),
              },
            ],
          };
        }

        // ③ 전문 조회 — 별표 목록을 앞에 붙인다
        const list = renderAnnexList(annexes);
        return {
          content: [
            {
              type: "text",
              text: `[${entry.name}] 전문 (${src})\n\n${list ? `${list}\n\n` : ""}${fullText}`,
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
