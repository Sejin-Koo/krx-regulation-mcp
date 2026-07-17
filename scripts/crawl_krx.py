#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KRX regulation.krx.co.kr / listing.krx.co.kr 전체 페이지 크롤러
- 사이트맵 기반 정적 JSP 페이지 194(RGL) + 60(LST) = 254개
- 본문(article.body-content) 텍스트만 추출, 메뉴/푸터 제거
- JSON Lines 형태로 저장 (한 줄에 한 페이지)
"""
import re
import json
import time
import sys
import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

# KRX가 일부 페이지(주로 "규정 원문 링크" 역할만 하던 페이지)를 rule.krx.co.kr(법무포털)로
# 이관하면서, 원래 URL은 실제 내용 대신 이 안내문구만 반환하는 경우가 있다(2026.7 확인).
# 이런 페이지는 정보가 없으므로 자동으로 건너뛴다.
DEAD_MARKERS = ["법규사이트로 이동", "KRX 법규사이트 바로가기"]

def extract_body(html: str) -> str:
    """article class="body-content" ~ 다음 </article> 사이만 추출, 태그 제거"""
    m = re.search(r'<article class="body-content">(.*?)</article>', html, re.S)
    if not m:
        return ""
    frag = m.group(1)
    # 이미지/스크립트 태그 등 제거
    frag = re.sub(r'<script.*?</script>', ' ', frag, flags=re.S)
    frag = re.sub(r'<style.*?</style>', ' ', frag, flags=re.S)
    frag = re.sub(r'<[^>]+>', ' ', frag)
    frag = re.sub(r'&nbsp;', ' ', frag)
    frag = re.sub(r'&amp;', '&', frag)
    frag = re.sub(r'\s+', ' ', frag).strip()
    return frag

def extract_title(html: str) -> str:
    m = re.search(r'<title>(.*?)</title>', html, re.S)
    if m:
        return re.sub(r'\s+', ' ', m.group(1)).strip()
    return ""

def extract_breadcrumb(html: str) -> str:
    """h1 (페이지 대제목) 근처 텍스트 - 보통 body-content 시작 부분에 카테고리명이 있음"""
    m = re.search(r'<h1[^>]*>(.*?)</h1>', html, re.S)
    if m:
        return re.sub(r'<[^>]+>', '', m.group(1)).strip()
    return ""

def classify(url: str) -> dict:
    """URL 코드로 시장/카테고리 대략 분류"""
    market = "공통"
    if "LST/04/0401" in url or "LST/04/04010" in url:
        market = "유가증권시장"
    elif "LST/04/0402" in url:
        market = "코스닥시장"
    elif "LST/04/0403" in url:
        market = "코넥스시장"
    elif "RGL/02/0201" in url or "RGL/03/0301" in url:
        market = "유가증권시장"
    elif "RGL/02/0202" in url or "RGL/03/0302" in url:
        market = "코스닥시장"
    elif "RGL/02/0203" in url or "RGL/03/0303" in url:
        market = "코넥스시장"

    if "/LST/" in url:
        rule_type = "상장"
    elif "RGL/02" in url:
        rule_type = "공시"
    elif "RGL/03" in url:
        rule_type = "매매거래"
    elif "RGL/06" in url:
        rule_type = "청산결제"
    elif "RGL/07" in url or "RGL/08" in url:
        rule_type = "회원·참가자"
    elif "RGL/09" in url:
        rule_type = "규제개혁"
    elif "RGL/04" in url:
        rule_type = "일반상품"
    else:
        rule_type = "기타"
    return {"market": market, "rule_type": rule_type}

def crawl(url_file: str, out_f, source: str):
    with open(url_file, encoding="utf-8") as f:
        urls = [l.strip() for l in f if l.strip()]
    total = len(urls)
    ok, fail = 0, 0
    for i, url in enumerate(urls, 1):
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            if r.status_code != 200:
                fail += 1
                print(f"[{i}/{total}] FAIL {r.status_code} {url}", file=sys.stderr)
                continue
            r.encoding = r.apparent_encoding or "utf-8"
            html = r.text
            if any(marker in html for marker in DEAD_MARKERS):
                fail += 1
                print(f"[{i}/{total}] SKIP(폐지된 페이지, rule.krx.co.kr로 이관됨) {url}", file=sys.stderr)
                continue
            body = extract_body(html)
            if len(body) < 10:
                fail += 1
                print(f"[{i}/{total}] SKIP(본문 없음/구조 변경 의심) {url}", file=sys.stderr)
                continue
            title = extract_title(html)
            h1 = extract_breadcrumb(html)
            meta = classify(url)
            record = {
                "source": source,
                "url": url,
                "title": title,
                "h1": h1,
                "market": meta["market"],
                "rule_type": meta["rule_type"],
                "body_len": len(body),
                "body": body,
            }
            out_f.write(json.dumps(record, ensure_ascii=False) + "\n")
            ok += 1
            if i % 20 == 0 or i == total:
                print(f"[{source}] {i}/{total} 완료 (성공 {ok}, 실패 {fail})", file=sys.stderr)
        except Exception as e:
            fail += 1
            print(f"[{i}/{total}] ERROR {url} : {e}", file=sys.stderr)
        time.sleep(0.15)  # 서버 부하 방지
    return ok, fail

if __name__ == "__main__":
    with open("krx_pages.jsonl", "w", encoding="utf-8") as out_f:
        ok1, fail1 = crawl("rgl_urls.txt", out_f, "regulation.krx.co.kr")
        ok2, fail2 = crawl("lst_urls.txt", out_f, "listing.krx.co.kr")
    print(f"\n=== 완료 === RGL 성공/실패: {ok1}/{fail1}  LST 성공/실패: {ok2}/{fail2}", file=sys.stderr)
