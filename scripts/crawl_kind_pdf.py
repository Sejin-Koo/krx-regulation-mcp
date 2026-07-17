#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KIND(kind.krx.co.kr) 게시 공시·상장관리 해설서 PDF 크롤러
- regulation.krx.co.kr / listing.krx.co.kr 사이트맵에는 없는 "투자주의환기종목" 등
  상장관리업무 세부 지정요건은 이 해설서 PDF에만 상세히 기재되어 있어 별도 소스로 추가.
- 페이지 단위로 텍스트를 추출하여 JSON Lines로 저장 (기존 크롤러와 동일 스키마 유지).
- 소스 목록: scripts/kind_pdf_sources.txt (탭 구분: url \t market \t 문서제목)
"""
import re
import sys
import json
import time
import requests
from io import BytesIO
from pypdf import PdfReader

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

CHAPTER_RE = re.compile(r"제\s*([1-9])\s*장\s*([^\n]{2,20})")
SECTION_RE = re.compile(r"([\u2160-\u2169]+)\s+([^\n0-9][^\n]{1,40})")


def extract_pdf_pages(pdf_bytes: bytes):
    reader = PdfReader(BytesIO(pdf_bytes))
    return [(p.extract_text() or "") for p in reader.pages]


def crawl(source_file: str, out_f):
    with open(source_file, encoding="utf-8") as f:
        lines = [l.rstrip("\n") for l in f if l.strip()]

    ok, fail = 0, 0
    for line in lines:
        parts = line.split("\t")
        if len(parts) < 3:
            print(f"SKIP (형식 오류): {line}", file=sys.stderr)
            continue
        url, market, doc_title = parts[0], parts[1], parts[2]
        try:
            r = requests.get(url, headers=HEADERS, timeout=60)
            if r.status_code != 200:
                fail += 1
                print(f"FAIL {r.status_code} {url}", file=sys.stderr)
                continue
            pages = extract_pdf_pages(r.content)
        except Exception as e:
            fail += 1
            print(f"ERROR {url} : {e}", file=sys.stderr)
            continue

        current_chapter = ""
        current_section = ""
        total = len(pages)
        for idx, body in enumerate(pages, 1):
            body = re.sub(r"\s+", " ", body).strip()
            ch = CHAPTER_RE.findall(body)
            if ch:
                current_chapter = f"제{ch[-1][0]}장 {ch[-1][1].strip()}"
            sec = SECTION_RE.findall(body)
            if sec:
                current_section = f"{sec[-1][0]} {sec[-1][1].strip()}"

            if not body:
                continue

            record = {
                "source": "kind.krx.co.kr",
                "url": url,
                "title": f"{doc_title} | {current_chapter} | {current_section}".strip(" |"),
                "h1": current_section or current_chapter or doc_title,
                "market": market,
                "rule_type": "상장관리해설서",
                "category_l1": current_chapter or doc_title,
                "category_l2": current_section,
                "breadcrumb": [doc_title, current_chapter, current_section],
                "page_name": current_section or current_chapter or doc_title,
                "page_no": idx,
                "body_len": len(body),
                "body": body,
            }
            out_f.write(json.dumps(record, ensure_ascii=False) + "\n")
            ok += 1
            if idx % 50 == 0 or idx == total:
                print(f"[{doc_title}] {idx}/{total} 페이지 처리 완료", file=sys.stderr)
        time.sleep(0.2)
    return ok, fail


if __name__ == "__main__":
    with open("kind_pdf_pages.jsonl", "w", encoding="utf-8") as out_f:
        ok, fail = crawl("kind_pdf_sources.txt", out_f)
    print(f"\n=== KIND PDF 완료 === 성공 {ok} 페이지 / 실패 {fail}건", file=sys.stderr)
