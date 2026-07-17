#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json

MARKET_KEYWORDS = {
    "유가증권시장": ["유가증권", "유가시장", "유가"],
    "코스닥시장": ["코스닥"],
    "코넥스시장": ["코넥스"],
}

def guess_market(crumbs):
    text = " ".join(crumbs)
    for market, kws in MARKET_KEYWORDS.items():
        if any(kw in text for kw in kws):
            return market
    return "공통"

records = []
with open("krx_pages.jsonl", encoding="utf-8") as f:
    for line in f:
        r = json.loads(line)
        # title 예: "Regulation | 공시제도 | 유가증권 공시 | 공시의 개요 | 공시제도의 의의 및 요건"
        parts = [p.strip() for p in r["title"].split("|")]
        crumbs = parts[1:] if len(parts) > 1 else parts
        r["breadcrumb"] = crumbs
        r["category_l1"] = crumbs[0] if len(crumbs) > 0 else ""
        r["category_l2"] = crumbs[1] if len(crumbs) > 1 else ""
        r["page_name"] = crumbs[-1] if crumbs else r["h1"].split("\r")[0].strip()
        r["market"] = guess_market(crumbs)
        records.append(r)

with open("krx_pages_final.jsonl", "w", encoding="utf-8") as f:
    for r in records:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

# 카테고리 트리 요약 출력
from collections import defaultdict
tree = defaultdict(lambda: defaultdict(int))
for r in records:
    tree[r["category_l1"]][r["market"]] += 1

print(f"총 {len(records)}건 재분류 완료\n")
print("=== 대분류(category_l1) x 시장 분포 ===")
for l1, markets in sorted(tree.items(), key=lambda x: -sum(x[1].values())):
    total = sum(markets.values())
    market_str = ", ".join(f"{m}:{c}" for m, c in markets.items())
    print(f"{l1:20s} 총{total:3d}건  ({market_str})")
