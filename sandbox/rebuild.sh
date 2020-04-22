#!/bin/bash

# Rebuild artifacts
if [[ ! -v SKIP_BUILD ]]; then
    npm run build
fi

# Remove tmp chaindb if exists
rm -Rf ./chaindb
mkdir ./chaindb

node ../../../node_modules/ganache-cli/cli.js \
    --gasLimit "0x7A1200" \
    --db ./chaindb \
    --defaultBalanceEther 100000 \
    --mnemonic "myth like bonus scare over problem client lizard pioneer submit female collect" &

ts-node ../scripts/deployLocal.ts

# Stop ganache-cli
pkill -f ganache-cli

# Rebuild docker image
tag=`git rev-parse --short HEAD`
docker build -t swapnet-lite-sandbox:$tag .
docker tag swapnet-lite-sandbox:$tag docker.pkg.github.com/jeffywu/swapnet-lite/swapnet-lite-sandbox:$tag
docker tag swapnet-lite-sandbox:$tag docker.pkg.github.com/jeffywu/swapnet-lite/swapnet-lite-sandbox:latest
# docker push docker.pkg.github.com/jeffywu/swapnet-lite/swapnet-lite-sandbox:$tag
# docker push docker.pkg.github.com/jeffywu/swapnet-lite/swapnet-lite-sandbox:latest