#!/bin/bash
set -e

function cleanup {
    pkill -f ganache-cli
}
trap cleanup EXIT

# Rebuild artifacts
if [ -z "$1" ]; then
    npm run build
else
    echo "Skipping build..."
fi

# Remove tmp chaindb if exists
rm -Rf ./chaindb
mkdir ./chaindb

node ../node_modules/ganache-cli/cli.js \
    --gasLimit "0x7A1200" \
    --db ./chaindb \
    --networkId 1337 \
    --defaultBalanceEther 100000 \
    --mnemonic "myth like bonus scare over problem client lizard pioneer submit female collect" &

DEBUG=* DOTENV_CONFIG_PATH=../.env.local ts-node ../scripts/deploy.ts
DEBUG=* DOTENV_CONFIG_PATH=../.env.local ts-node ../scripts/setupLiquidity.ts

# Rebuild docker image
tag=`git rev-parse --short HEAD`
docker build -t notional/sandbox:$tag .
docker tag notional/sandbox:$tag notional/sandbox:latest