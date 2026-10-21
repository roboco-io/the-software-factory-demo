#!/usr/bin/env bash
# 로컬 wrangler dev(로컬 D1)를 띄우고 포럼 API 계약 스위트(tests/forum/vendor)를 실행한다.
# 책 동기화는 고정 데이터(fixtures/book-v1, book-v2)를 로컬 HTTP 서버로 내보내고 scheduled 핸들러를 호출해 시험한다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8789}"
BOOK_PORT="${BOOK_PORT:-8790}"
HOST="http://localhost:$PORT"
VENDOR="$ROOT/tests/forum/vendor"
SKIP_FILE="$ROOT/tests/forum/skip.txt"

SKIP=()
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  if [ ! -f "$VENDOR/$line" ]; then echo "skip.txt lists unknown file: $line" >&2; exit 2; fi
  SKIP+=("$line")
done < "$SKIP_FILE"

# 짝을 이루는 파일은 함께 건너뛰거나 함께 실행한다(revision_after는 revision_before가 연 토론을 확인한다).
in_skip() {
  if [ "${#SKIP[@]}" -gt 0 ]; then
    for s in "${SKIP[@]}"; do [ "$s" = "$1" ] && return 0; done
  fi
  return 1
}
for f in "$VENDOR"/*_after.hurl; do
  after="$(basename "$f")"
  before="${after%_after.hurl}_before.hurl"
  a=0; b=0
  in_skip "$after" && a=1
  in_skip "$before" && b=1
  if [ "$a" != "$b" ]; then echo "skip.txt must list $before and $after together" >&2; exit 2; fi
done

# 건너뛰는 파일도 문법은 검사한다. 계약 파일이 깨진 채로 남지 않게 한다.
for f in "$VENDOR"/*.hurl; do
  hurlfmt --out json "$f" > /dev/null || { echo "invalid hurl: $(basename "$f")" >&2; exit 2; }
done

# *_after.hurl은 book-v2로 다시 동기화한 뒤 실행한다.
BEFORE=()
AFTER=()
for f in "$VENDOR"/*.hurl; do
  name="$(basename "$f")"
  if in_skip "$name"; then
    echo "skip: $name"
  elif [[ "$name" == *_after.hurl ]]; then
    AFTER+=("$f")
  else
    BEFORE+=("$f")
  fi
done

WORK="$(mktemp -d)"
BOOK="$WORK/book"
STATE="$WORK/state"
LOG="$ROOT/.wrangler-forum.log"
PID=""
BOOK_PID=""
# bash 3.2에서 빈 변수로 kill하면 실패하므로 값이 있을 때만 종료한다.
cleanup() {
  for p in $PID $BOOK_PID; do kill "$p" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT
serve_book() {
  rm -rf "$BOOK"
  cp -R "$VENDOR/fixtures/$1" "$BOOK"
}
serve_book book-v1
python3 -m http.server "$BOOK_PORT" --bind 127.0.0.1 --directory "$BOOK" > "$WORK/book.log" 2>&1 &
BOOK_PID=$!

cd "$ROOT/apps/api"
pnpm exec wrangler d1 migrations apply sfd-prod --local --persist-to "$STATE"
pnpm exec wrangler dev --port "$PORT" --persist-to "$STATE" --test-scheduled \
  --var JWT_SECRET:forum-local --var "BOOK_SOURCE_URL:http://127.0.0.1:$BOOK_PORT" > "$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 60); do
  curl -fsS "$HOST/api/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$HOST/api/health" > /dev/null || { tail -n 50 "$LOG"; exit 1; }

# 동기화 결과는 계약 파일이 확인한다. scheduled 핸들러가 아직 없으면 실패해도 여기서는 멈추지 않는다.
# 목차 API가 있으면 syncedAt이 바뀔 때까지 최대 30초 기다린다. 핸들러가 일을 뒤로 미뤄도 경합하지 않게 한다.
synced_at() {
  curl -fsS "$HOST/api/book" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("syncedAt"))' 2>/dev/null || echo "unavailable"
}
# 로컬 workerd가 처음 고정 데이터 서버에 연결할 때 "Network connection lost"로 한 번 실패한 적이 있다(2026-10-21).
# 동기화가 반영되지 않으면 최대 3회 다시 호출한다. 동기화 실패는 기존 데이터를 바꾸지 않으므로 다시 호출해도 안전하다.
sync_book() {
  local status before now attempt
  before="$(synced_at)"
  for attempt in 1 2 3; do
    status="$(curl -s -o /dev/null -w '%{http_code}' "$HOST/__scheduled" || true)"
    echo "book sync ($1, attempt $attempt): HTTP $status"
    [ "$before" = "unavailable" ] && return 0
    for _ in $(seq 1 20); do
      now="$(synced_at)"
      if [ "$now" != "$before" ] && [ "$now" != "None" ]; then return 0; fi
      sleep 0.5
    done
  done
  echo "book sync ($1): syncedAt did not change after 3 attempts (before=$before now=$now)" >&2
}

UID_VAR="$(date +%s)$$"
sync_book book-v1
if [ "${#BEFORE[@]}" -gt 0 ]; then
  hurl --test --jobs 1 --variable "host=$HOST" --variable "uid=$UID_VAR" "${BEFORE[@]}"
fi
if [ "${#AFTER[@]}" -gt 0 ]; then
  serve_book book-v2
  sync_book book-v2
  hurl --test --jobs 1 --variable "host=$HOST" --variable "uid=$UID_VAR" "${AFTER[@]}"
fi
if [ "${#BEFORE[@]}" -eq 0 ] && [ "${#AFTER[@]}" -eq 0 ]; then
  echo "모든 포럼 계약 파일이 skip.txt에 있다. 실행한 계약 없음."
fi
