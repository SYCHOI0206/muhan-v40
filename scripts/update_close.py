#!/usr/bin/env python3
"""Fetch the latest completed daily close and write data/latest-close.json.

This script runs in GitHub Actions, so the browser never calls a market-data
provider directly and therefore does not depend on third-party CORS headers.
"""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "latest-close.json"
TICKER = os.environ.get("TICKER", "SOXL").strip().upper() or "SOXL"
USER_AGENT = "Mozilla/5.0 (compatible; muhan-v40-close-updater/2.0)"


def request_bytes(url: str, attempts: int = 4, timeout: int = 25) -> bytes:
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            req = Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/json,text/csv,text/plain,*/*",
                },
            )
            with urlopen(req, timeout=timeout) as response:
                return response.read()
        except (HTTPError, URLError, TimeoutError) as exc:
            last = exc
            if attempt + 1 < attempts:
                time.sleep(2**attempt)
    raise RuntimeError(f"request failed: {url}: {last}")


def fetch_yahoo(host: str) -> dict[str, Any]:
    url = (
        f"https://{host}/v8/finance/chart/{quote(TICKER)}"
        "?range=10d&interval=1d&includePrePost=false&events=div%2Csplits"
    )
    data = json.loads(request_bytes(url).decode("utf-8"))
    error = data.get("chart", {}).get("error")
    if error:
        raise RuntimeError(f"Yahoo error: {error}")
    results = data.get("chart", {}).get("result") or []
    if not results:
        raise RuntimeError("Yahoo response has no result")
    result = results[0]
    timestamps = result.get("timestamp") or []
    quote_data = (((result.get("indicators") or {}).get("quote") or [{}])[0])
    closes = quote_data.get("close") or []
    opens = quote_data.get("open") or []
    highs = quote_data.get("high") or []
    lows = quote_data.get("low") or []
    volumes = quote_data.get("volume") or []
    ny = ZoneInfo("America/New_York")
    for i in range(min(len(timestamps), len(closes)) - 1, -1, -1):
        close = closes[i]
        if close is None or float(close) <= 0:
            continue
        ts = int(timestamps[i])
        date = datetime.fromtimestamp(ts, ny).date().isoformat()
        def value(arr: list[Any]) -> float | int | None:
            if i >= len(arr) or arr[i] is None:
                return None
            return arr[i]
        return {
            "ticker": TICKER,
            "date": date,
            "open": value(opens),
            "high": value(highs),
            "low": value(lows),
            "close": float(close),
            "volume": value(volumes),
            "source": f"Yahoo Finance ({host})",
        }
    raise RuntimeError("Yahoo response has no valid daily close")


def fetch_stooq_with_optional_key() -> dict[str, Any]:
    key = os.environ.get("STOOQ_API_KEY", "").strip()
    if not key:
        raise RuntimeError("STOOQ_API_KEY is not configured")
    symbol = TICKER.lower() + ("" if "." in TICKER else ".us")
    url = f"https://stooq.com/q/d/l/?s={quote(symbol)}&i=d&apikey={quote(key)}"
    text = request_bytes(url).decode("utf-8-sig", errors="replace")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise RuntimeError("Stooq response has no CSV rows")
    row = rows[-1]
    close = float(row["Close"])
    if close <= 0:
        raise RuntimeError("Stooq returned an invalid close")
    def num(name: str) -> float | int | None:
        value = row.get(name)
        if value in (None, "", "N/D", "-"):
            return None
        return int(value) if name == "Volume" else float(value)
    return {
        "ticker": TICKER,
        "date": row["Date"],
        "open": num("Open"),
        "high": num("High"),
        "low": num("Low"),
        "close": close,
        "volume": num("Volume"),
        "source": "Stooq",
    }


def fetch_latest() -> dict[str, Any]:
    errors: list[str] = []
    for provider in (
        lambda: fetch_yahoo("query1.finance.yahoo.com"),
        lambda: fetch_yahoo("query2.finance.yahoo.com"),
        fetch_stooq_with_optional_key,
    ):
        try:
            return provider()
        except Exception as exc:  # keep trying independent providers
            errors.append(str(exc))
    raise RuntimeError("all providers failed: " + " | ".join(errors))


def main() -> int:
    quote_data = fetch_latest()
    quote_data["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    quote_data["schema_version"] = 2
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUTPUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(quote_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(OUTPUT)
    print(json.dumps(quote_data, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
