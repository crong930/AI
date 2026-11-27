#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 설치돼 있지 않아요. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요."
  read -n 1; exit 1
fi
[ -f config.json ] || cp config.example.json config.json
node server.js
