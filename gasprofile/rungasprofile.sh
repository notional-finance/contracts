yarn run sandbox:build

rm .cid
docker run --cidfile=.cid -d -p 8545:8545 --memory="8g" notional/sandbox:latest

DEBUG=gas* DOTENV_CONFIG_PATH=../.env.local ts-node ./Gas.ts

docker stop `cat .cid`