#!/bin/bash
docker-compose up -d
echo "Sleeping 10 seconds for the graph to start..."
sleep 10
graph create --node http://127.0.0.1:8020 swapnet-protocol/swapnet-lite
graph deploy swapnet-protocol/swapnet-lite ../graph/subgraph.yaml --ipfs http://localhost:5001 --node http://127.0.0.1:8020

DEBUG=* ts-node ../scripts/setup.ts