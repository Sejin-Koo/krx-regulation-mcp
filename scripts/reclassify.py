#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v2 (2026-07-21): krx_pages.jsonl이 없거나(크롤링 단계가 아예 시작 전 취소된 경우) 비어있어도
(부분 크롤링만 되고 취소된 경우) 에러 없이 "있는 만큼"만 처리하고 넘어가도록 수정.
이전 버전은 파일이 없으면 FileNotFoundError로 전체 워크플로우가 죽어서, 이후 커밋 단계까지
아예 실행되지 않는 문제가 있었음(체크포인트 커밋이 의미가 없어짐).
"""
import json
import os
import sys

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
if os.path.exists("krx_pages.jsonl"):
    with open("krx_pages.jsonl", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                # 타임아웃 시 마지막 줄이 중간에 잘렸을 가능성 대비(방어적 처리)
                continue
            # title 예: "Regulation | 공시제도 | 유가증권 공시 | 공시의 개요 | 공시제도의 의의 및 요건"
            parts = [p.strip() for p in r["title"].split("|")]
            crumbs = parts[1:] if len(parts) > 1 else parts
            r["breadcrumb"] = crumbs
            r["category_l1"] = crumbs[0] if len(crumbs) > 0 else ""
            r["category_l2"] = crumbs[1] if len(crumbs) > 1 else ""
            r["page_name"] = crumbs[-1] if crumbs else r["h1"].split("\r")[0].strip()
            r["market"] = guess_market(crumbs)
            records.append(r)
else:
    print("경고: krx_pages.jsonl 없음 (크롤링 단계가 시작되기 전 중단된 것으로 보임) - 빈 결과로 진행", file=sys.stderr, flush=True)

with open("krx_pages_final.jsonl", "w", encoding="utf-8") as f:
    for r in records:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

# 카테고리 트리 요약 출력
from collections import defaultdict
tree = defaultdict(lambda: defaultdict(int))
for r in records:
    tree[r["category_l1"]][r["market"]] += 1

print(f"총 {len(records)}건 재분류 완료\n", flush=True)
print("=== 대분류(category_l1) x 시장 분포 ===", flush=True)
for l1, markets in sorted(tree.items(), key=lambda x: -sum(x[1].values())):
    total = sum(markets.values())
    market_str = ", ".join(f"{m}:{c}" for m, c in markets.items())
    print(f"{l1:20s} 총{total:3d}건  ({market_str})", flush=True)
