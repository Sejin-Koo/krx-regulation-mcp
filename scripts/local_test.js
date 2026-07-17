import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, PAGE_COUNT } from "../lib/server.js";

async function main() {
  console.log(`데이터 로드 확인: 총 ${PAGE_COUNT}건\n`);

  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const tools = await client.listTools();
  console.log("=== tools/list ===");
  console.log(tools.tools.map((t) => t.name).join(", "));
  console.log();

  console.log("=== search_krx_regulation(keyword='우회상장') ===");
  const r1 = await client.callTool({
    name: "search_krx_regulation",
    arguments: { keyword: "우회상장" },
  });
  console.log(r1.content[0].text.slice(0, 800));
  console.log();

  console.log("=== search_krx_regulation(market='코스닥시장', category='주권상장', limit=3) ===");
  const r2 = await client.callTool({
    name: "search_krx_regulation",
    arguments: { market: "코스닥시장", category: "주권상장", limit: 3 },
  });
  console.log(r2.content[0].text.slice(0, 1000));
  console.log();

  console.log("=== get_krx_rule_fulltext(rule_name='코스닥시장 상장규정', article_no='제28조') ===");
  const r3 = await client.callTool({
    name: "get_krx_rule_fulltext",
    arguments: { rule_name: "코스닥시장 상장규정", article_no: "제28조" },
  });
  console.log(r3.content[0].text.slice(0, 600));

  await client.close();
  await server.close();
  console.log("\n=== 테스트 완료 ===");
}

main().catch((e) => {
  console.error("테스트 실패:", e);
  process.exit(1);
});
