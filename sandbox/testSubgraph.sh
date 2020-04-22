#!/bin/bash
./start.sh

DEBUG=* ts-node ../scripts/TestSubgraph.ts

docker-compose down