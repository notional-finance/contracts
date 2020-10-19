FROM trufflesuite/ganache-cli:latest

ADD chaindb /tmp/chaindb

ENV NODE_OPTIONS "--max-old-space-size=8192"

ENTRYPOINT [ "node", \
             "/app/ganache-core.docker.cli.js", \
             "--db", "/tmp/chaindb", \
             "--gasLimit", "0x7A1200", \
             "--networkId", "1337", \
             "--defaultBalanceEther", "100000", \
             "--verbose", \
             "--mnemonic", "myth like bonus scare over problem client lizard pioneer submit female collect" ]