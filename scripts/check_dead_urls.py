#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
기존 크롤링된 254개 해설 페이지(regulation.krx.co.kr / listing.krx.co.kr) URL의
생존 여부를 전수 점검한다. KRX가 일부 페이지를 rule.krx.co.kr(법무포털)로
이관하면서 원래 URL은 "법규사이트로 이동하세요" 안내 페이지로 바뀐 경우가 있어,
이를 자동 판별해 살아있는/죽은 URL을 분류한다.
"""
import json
import re
import sys
import time
import requests

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
}

DEAD_MARKERS = [
    "법규사이트로 이동",
    "KRX 법규사이트 바로가기",
]


def check_url(url):
    try:
        r = requests.get(url, headers=HEADERS, timeout=20)
    except Exception as e:
        return "ERROR", str(e)
    if r.status_code != 200:
        return "HTTP_ERROR", f"status={r.status_code}"
    body = r.text
    if any(marker in body for marker in DEAD_MARKERS):
        return "DEAD_REDIRECT", None
    m = re.search(r'<article[^>]*class="body-content"[^>]*>(.*?)</article>', body, re.S)
    if not m or len(re.sub(r"<[^>]+>", "", m.group(1)).strip()) < 30:
        return "EMPTY_OR_CHANGED", None
    return "ALIVE", None


def main(url_file):
    with open(url_file, encoding="utf-8") as f:
        urls = [l.strip() for l in f if l.strip()]

    results = {"ALIVE": [], "DEAD_REDIRECT": [], "EMPTY_OR_CHANGED": [], "HTTP_ERROR": [], "ERROR": []}
    for i, url in enumerate(urls, 1):
        status, detail = check_url(url)
        results[status].append({"url": url, "detail": detail})
        if i % 20 == 0 or i == len(urls):
            print(f"[{i}/{len(urls)}] 진행 중... (ALIVE={len(results['ALIVE'])}, DEAD={len(results['DEAD_REDIRECT'])}, "
                  f"CHANGED={len(results['EMPTY_OR_CHANGED'])}, ERROR={len(results['HTTP_ERROR'])+len(results['ERROR'])})",
                  file=sys.stderr)
        time.sleep(0.15)

    with open("url_check_results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print("\n=== 최종 결과 ===", file=sys.stderr)
    for k, v in results.items():
        print(f"{k}: {len(v)}건", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/all_urls.txt")
