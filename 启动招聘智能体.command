#!/bin/bash
set -u
cd "$(dirname "$0")/招聘智能体/recruitment-agent" || exit 1
if [ ! -d node_modules/electron ]; then
  npm install --no-audit --no-fund || exit 1
fi
if [ ! -f data/v1.4/jobs.db ]; then
  npm run v14:seed-demo || exit 1
fi
export V14_DB_PATH="$PWD/data/v1.4/jobs.db"
export V14_NODE="$(command -v node)"
export V14_PORT="4780"
if npm run electron; then
  exit 0
fi
echo "桌面客户端未启动，改用浏览器页面..."
export V14_PORT="4781"
node src/v14/cli/serve.js --port=4781 --db="$V14_DB_PATH" &
SERVER_PID=$!
sleep 2
open "http://127.0.0.1:4781"
echo "浏览器页面已打开：http://127.0.0.1:4781（服务 PID $SERVER_PID）"
