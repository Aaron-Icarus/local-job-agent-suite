#!/bin/bash
set -e
cd "$(dirname "$0")/招聘智能体/recruitment-agent"
if [ ! -d node_modules/electron ]; then
  npm install --no-audit --no-fund
fi
if [ ! -f data/v1.4/jobs.db ]; then
  npm run v14:seed-demo
fi
export V14_DB_PATH="$PWD/data/v1.4/jobs.db"
export V14_NODE="$(command -v node)"
export V14_PORT="4780"
npm run electron
