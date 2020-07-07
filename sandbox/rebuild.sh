#!/bin/bash

# Rebuild artifacts
if [[ ! -v SKIP_BUILD ]]; then
    npm run build
fi

docker stop tmpnode
docker rm tmpnode
docker run -v ${PWD}/config.toml:/tmp/config.toml -d -p 8545:8545 --name tmpnode openethereum/openethereum --config /tmp/config.toml
sleep 10

curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0x22d491Bde2303f2f43325b2108D26f1eAbA1e32b","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0xE11BA2b4D45Eaed5996Cd0823791E0C93114882d","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0xd03ea8624C8C5987235048901fB614fDcA89b117","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0x95cED938F7991cd0dFcb48F0a06a40FA1aF46EBC","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0x3E5e9111Ae8eB78Fe1CC3bb8915d5D461F3Ef9A9","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0x28a8746e75304c0780E011BEd21C72cD78cd535E","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0xACa94ef8bD5ffEE41947b4585a84BdA5a3d3DA6E","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
curl --data '{"method":"personal_sendTransaction","params":[{"from":"0x00a329c0648769a73afac7f9381e08fb43dbea72","to":"0x1dF62f291b2E969fB0849d99D9Ce41e2F137006e","data":"0x","value":"0x1fc3842bd1f071c00000"},""],"id":1,"jsonrpc":"2.0"}' -H "Content-Type: application/json" -X POST localhost:8545
DEBUG=* DOTENV_CONFIG_PATH=../.env.local ts-node ../scripts/deploy.ts

tag=`git rev-parse --short HEAD`
docker commit tmpnode swapnet-lite-sandbox:$tag
docker tag swapnet-lite-sandbox:$tag docker.pkg.github.com/jeffywu/swapnet-lite/swapnet-lite-sandbox:$tag
docker tag swapnet-lite-sandbox:$tag docker.pkg.github.com/jeffywu/swapnet-lite/swapnet-lite-sandbox:latest

docker stop tmpnode
docker rm tmpnode

# Tag Image
# docker push docker.pkg.github.com/jeffywu/swapnet-lite/swapnet-lite-sandbox:$tag
# docker push docker.pkg.github.com/jeffywu/swapnet-lite/swapnet-lite-sandbox:latest