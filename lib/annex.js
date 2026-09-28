// 별표(첨부) 지원 — 조문 원문과 함께 별표 목록·본문을 돌려주기 위한 모듈
//
// 1) 목록: rule.krx.co.kr regulationViewPop.do 응답 HTML의 "별표 및 서식"(#byullist)을 파싱한다.
//    조문 원문을 가져올 때 이미 받는 HTML이므로 추가 요청이 없다. 제목과 KRX가 표기한
//    개정일이 여기서 나온다(실시간 = 현행 기준).
// 2) 본문: 별표 원본은 HWP 첨부라 이 서버가 직접 받지 않는다. 대신 PDF Vector DB MCP 서버의
//    krx_listing_disclosure 컬렉션에 저장된 사본을 get_chunk_text로 가져온다. 호출자가 이
//    서버에 쓴 게이트키를 그대로 전달하므로 별도 환경변수가 필요 없다(같은 키가 두 서버에
//    모두 등록된 경우에만 동작하고, 아니면 조회 방법을 안내한다).
// 3) 두 출처의 개정일 표기를 비교해 다르면 응답에 밝힌다. 저장본이 낡았을 수 있기 때문이다.

const PDF_DB_ENDPOINT =
  process.env.PDF_DB_MCP_ENDPOINT || "https://pdf-vector-db-mcp.vercel.app/api/mcp";
const COLLECTION = "krx_listing_disclosure";
const MAX_ANNEX_CHARS = 20000; // 별표 1건당 본문 상한
const MAX_CHUNKS = 15; // 별표 1건당 청크 상한

const normalize = (s) => (s ? s.replace(/\s+/g, "").replace(/\u3000/g, "") : "");

const decode = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

// "별표 10" / "별표10" / "[별표 2의2]" → "별표10" / "별표2의2". 별표가 아니면 null.
export function annexKey(s) {
  const m = (s || "").match(/별표\s*(\d+)(?:\s*의\s*(\d+))?/);
  if (!m) return null;
  return m[2] ? `별표${m[1]}의${m[2]}` : `별표${m[1]}`;
}

// regulationViewPop.do HTML → [{kind, key, title, revisions, deleted}]
// 별표 항목은 두 곳에 있다(2026-09 실측). 본문 끝의 <p class="byulText">에는 개정일 표기가
// 붙어 있고, "별표 및 서식" 목록(#byullist)의 <p class="attachText">에는 제목만 있으며 삭제된
// 별표도 이쪽에만 나온다. 둘을 합치되 개정일이 있는 쪽을 우선한다.
export function parseAnnexList(html) {
  const byKind = new Map();
  const re = /<p class="(byulText|attachText)">([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const label = decode(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    const head = label.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!head) continue;
    const kind = head[1].replace(/\s+/g, "");
    const rest = head[2];
    const rev = rest.match(/<([^<>]*)>\s*$/);
    const title = (rev ? rest.slice(0, rev.index) : rest).trim();
    const item = {
      kind,
      key: annexKey(kind),
      title,
      revisions: rev ? rev[1].trim() : "",
      deleted: /^삭제/.test(title),
    };
    const prev = byKind.get(kind);
    if (!prev || (!prev.revisions && item.revisions)) byKind.set(kind, item);
  }
  return [...byKind.values()];
}

// 조문 본문에서 인용된 별표 키를 순서대로(중복 없이) 뽑는다.
export function referencedAnnexKeys(text) {
  const keys = [];
  const re = /별표\s*\d+(?:\s*의\s*\d+)?/g;
  let m;
  while ((m = re.exec(text || "")) !== null) {
    const k = annexKey(m[0]);
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

// "2025.11.21." / "2025. 11. 24" → "2025.11.21" 형태의 집합
function dateSet(s) {
  const set = new Set();
  const re = /(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/g;
  let m;
  while ((m = re.exec(s || "")) !== null) set.add(`${m[1]}.${Number(m[2])}.${Number(m[3])}`);
  return set;
}

export function compareRevisions(live, stored) {
  const a = dateSet(live);
  const b = dateSet(stored);
  if (a.size === 0 || b.size === 0) return null;
  const onlyLive = [...a].filter((d) => !b.has(d));
  const onlyStored = [...b].filter((d) => !a.has(d));
  if (!onlyLive.length && !onlyStored.length) return null;
  return { onlyLive, onlyStored };
}

async function mcpCall(gateKey, name, args) {
  const url = gateKey ? `${PDF_DB_ENDPOINT}?k=${encodeURIComponent(gateKey)}` : PDF_DB_ENDPOINT;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  if (!res.ok) throw new Error(`PDF Vector DB 응답 오류: HTTP ${res.status}`);
  const raw = await res.text();
  let json = null;
  const t = raw.trim();
  if (t.startsWith("{")) {
    json = JSON.parse(t);
  } else {
    const line = raw.split("\n").reverse().find((l) => l.startsWith("data:"));
    if (line) json = JSON.parse(line.slice(5));
  }
  if (!json) throw new Error("PDF Vector DB 응답이 비어 있음");
  if (json.error) throw new Error(`PDF Vector DB 오류: ${json.error.message}`);
  return ((json.result && json.result.content) || []).map((c) => c.text || "").join("\n");
}

// get_chunk_text 응답 → [{title, index, text}]
function parseChunks(text) {
  const out = [];
  for (const part of text.split(/\n─{4,}\n?/)) {
    const m = part.match(/■ (.+?) p\.[^\n]*\(chunk_index (\d+),[^\n]*\)\n\n([\s\S]*)$/);
    if (m) out.push({ title: m[1].trim(), index: Number(m[2]), text: m[3].trim() });
  }
  return out;
}

// 문서명이 "<규정명> <별표키> ..." 인지 (규정명 뒤에 바로 그 별표가 와야 한다 —
// "코스닥시장 상장규정"이 "코스닥시장 상장규정 시행세칙"에, "별표1"이 "별표10"에 걸리지 않게)
function titleMatches(title, ruleName, key) {
  const t = normalize(title);
  const r = normalize(ruleName);
  if (!t.startsWith(r)) return false;
  const rest = t.slice(r.length);
  if (!rest.startsWith(key)) return false;
  const next = rest.slice(key.length);
  return !/^(\d|의)/.test(next);
}

// 벡터DB 사본에서 별표 본문을 가져온다. 못 찾으면 null.
export async function fetchAnnexFromDb(gateKey, ruleName, key) {
  const first = parseChunks(
    await mcpCall(gateKey, "get_chunk_text", {
      collection: COLLECTION,
      doc_title: `${ruleName} ${key}`,
      chunk_index: 0,
      limit: 20,
    })
  ).filter((c) => titleMatches(c.title, ruleName, key));
  if (!first.length) return null;
  const title = first[0].title;

  const list = await mcpCall(gateKey, "get_chunk_text", { collection: COLLECTION, doc_title: title, limit: 20 });
  const idx = [...new Set([...list.matchAll(/chunk_index (\d+)/g)].map((x) => Number(x[1])))]
    .filter((i) => i > 0)
    .sort((a, b) => a - b)
    .slice(0, MAX_CHUNKS - 1);

  const rest = await Promise.all(
    idx.map((i) =>
      mcpCall(gateKey, "get_chunk_text", { collection: COLLECTION, doc_title: title, chunk_index: i, limit: 5 })
        .then((t) => parseChunks(t).find((c) => c.title === title) || null)
        .catch(() => null)
    )
  );
  const chunks = [first[0], ...rest.filter(Boolean)].sort((a, b) => a.index - b.index);
  let body = chunks.map((c) => c.text).join("\n\n");
  const truncated = body.length > MAX_ANNEX_CHARS;
  if (truncated) body = body.slice(0, MAX_ANNEX_CHARS);
  const head = chunks[0].text.match(/<([^<>]*개정[^<>]*)>/);
  return {
    title,
    body,
    truncated,
    storedRevisions: head ? head[1].trim() : "",
    missingChunks: idx.length - rest.filter(Boolean).length,
  };
}

// 별표 1건을 응답용 텍스트 블록으로 만든다.
export async function renderAnnex(gateKey, ruleName, annex) {
  const lines = [`■ [${annex.kind}] ${annex.title}`];
  lines.push(`· KRX 법무포털 목록(실시간, 현행 기준) 개정 표기: ${annex.revisions || "(표기 없음)"}`);
  if (annex.deleted) {
    lines.push("· 삭제된 별표입니다.");
    return lines.join("\n");
  }
  const call = `get_chunk_text(collection="${COLLECTION}", doc_title="${ruleName} ${annex.key}")`;
  try {
    const got = await fetchAnnexFromDb(gateKey, ruleName, annex.key);
    if (!got) {
      lines.push(`· 본문: PDF Vector DB(${COLLECTION})에 이 별표의 사본이 없습니다. 원문은 rule.krx.co.kr에서 확인하세요.`);
      return lines.join("\n");
    }
    lines.push(`· 본문 출처: PDF Vector DB ${COLLECTION} 「${got.title}」 (저장본 개정 표기: ${got.storedRevisions || "없음"})`);
    const diff = compareRevisions(annex.revisions, got.storedRevisions);
    if (diff) {
      lines.push(
        `· ⚠ 개정일 표기가 다릅니다 — KRX 목록에만 있음: ${diff.onlyLive.join(", ") || "없음"} / 저장본에만 있음: ${
          diff.onlyStored.join(", ") || "없음"
        }. KRX 목록이 현행 기준이며, KRX 목록에만 있는 개정이 있으면 저장본이 그 개정을 반영하지 못했을 수 있습니다.`
      );
    }
    if (got.missingChunks > 0) lines.push(`· ⚠ 본문 청크 ${got.missingChunks}개를 가져오지 못했습니다. 필요하면 ${call}로 확인하세요.`);
    if (got.truncated) lines.push(`· ⚠ 본문이 길어 ${MAX_ANNEX_CHARS}자에서 잘랐습니다. 나머지는 ${call}로 확인하세요.`);
    lines.push("", got.body);
  } catch (e) {
    lines.push(`· 본문: PDF Vector DB 조회 실패(${e.message}). 다음으로 직접 조회하세요: ${call}`);
  }
  return lines.join("\n");
}

// 별표 목록 요약(본문 없이)
export function renderAnnexList(annexes) {
  const items = annexes.filter((a) => a.key);
  if (!items.length) return "";
  return (
    "[이 규정의 별표 목록 — KRX 법무포털 실시간]\n" +
    items.map((a) => `- [${a.kind}] ${a.title}${a.revisions ? ` <${a.revisions}>` : ""}`).join("\n") +
    '\n(별표 본문이 필요하면 article_no에 "별표N"을 넣어 다시 호출하세요.)'
  );
}
