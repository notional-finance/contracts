#!/bin/bash
set -e

function cleanup {
    pkill -f "npx buidler node"
}
trap cleanup EXIT

npx buidler node 2> /dev/null > /dev/null &
if [ "$ALL_TESTS" == "true" ];
then
    REPORT_GAS=true npx buidler test --network localhost $@
else
    REPORT_GAS=true npx buidler test test/Gas.ts --network localhost $@
fi