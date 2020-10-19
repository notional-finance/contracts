import chai from "chai";
import { solidity } from "ethereum-waffle";
import { Wallet, Contract } from 'ethers';
import { wallets, CURRENCY } from './fixtures';
import { NotionalDeployer } from '../scripts/NotionalDeployer';
import MockLiquidationArtifact from '../build/MockLiquidation.json';
import { MockLiquidation } from '../typechain/MockLiquidation';
import MockPortfoliosArtifact from '../build/MockPortfolios.json';
import MockAggregatorArtifact from '../mocks/MockAggregator.json';
import { MockPortfolios } from '../typechain/MockPortfolios';
import { AddressZero, WeiPerEther } from 'ethers/constants';
import { BigNumber, parseEther } from 'ethers/utils';
import { MockAggregator } from '../mocks/MockAggregator';

chai.use(solidity);
const { expect } = chai;

describe("Liquidation Calculations", () => {
  let owner: Wallet;
  let liquidation: MockLiquidation;
  let portfolios: MockPortfolios;
  let chainlink: MockAggregator;
  let defaultRateParams: any;
  const defaultLiquidityHaircut = parseEther("0.8");
  const defaultRepoIncentive = parseEther("1.10");
  const defaultLiquidationDiscount = parseEther("1.06");

  beforeEach(async () => {
    owner = wallets[0];
    const libraries = new Map<string, Contract>();

    libraries.set("Liquidation", (await NotionalDeployer.deployContract(
        owner,
        "Liquidation",
        [],
        1
    )).contract);

    liquidation = (await NotionalDeployer.deployContract(
      owner,
      MockLiquidationArtifact,
      [],
      1
    )).contract as MockLiquidation;

    portfolios = (await NotionalDeployer.deployContract(
      owner,
      MockPortfoliosArtifact,
      [],
      1
    )).contract as MockPortfolios;

    chainlink = (await NotionalDeployer.deployContract(
      owner,
      MockAggregatorArtifact,
      [],
      1
    )).contract as MockAggregator;
    // This is the localToETH rate oracle
    await chainlink.setAnswer(1e4);

    defaultRateParams = {
      rate: 1e6,
      localCurrency: 1,
      collateralCurrency: 2,
      localDecimals: WeiPerEther,
      collateralDecimals: 1e6,
      localToETH: {
        rateOracle: chainlink.address,
        rateDecimals: 1e6,
        mustInvert: false,
        buffer: parseEther("1.3")
      }
    }

    await liquidation.setParameters(
      defaultLiquidityHaircut,
      defaultLiquidationDiscount,
      parseEther("1.02"),
      defaultRepoIncentive
    );

    await portfolios.setHaircut(parseEther("0.8"));
  })

  it("calculates claims properly", async () => {
    await portfolios.setClaim(parseEther("1000"), parseEther("1000"));
    let claim = await portfolios.getClaim();
    expect(claim[0]).to.equal(parseEther("800"));
    expect(claim[1]).to.equal(parseEther("800"));

    await portfolios.setClaim(new BigNumber(1000e6), new BigNumber(1000e6));
    claim = await portfolios.getClaim();
    expect(claim[0]).to.equal(800e6);
    expect(claim[1]).to.equal(800e6);
  })

  describe("localLiquidityTokenTrade", async () => {

    it("raises the full amount when no remainder at 18 decimals", async () => {
      const expectedRaise = parseEther(Math.trunc(1000 * 1.1 / (1 - 0.8)).toString());

      await expect(liquidation.localLiquidityTokenTrade(
        AddressZero,
        CURRENCY.DAI,
        parseEther("1000"),
        defaultLiquidityHaircut,
        portfolios.address
      )).to.emit(liquidation, "LiquidityTokenTrade")
        .withArgs(
          expectedRaise,
          parseEther("1000")
        );

      const amountToRaise = await portfolios._amount(); 
      expect(amountToRaise).to.equal(expectedRaise);
    })

    it("raises the full amount when no remainder at 6 decimals", async () => {
      const expectedRaise = new BigNumber(Math.trunc(1000 * 1.1 / (1 - 0.8)) * 1e6);

      await expect(liquidation.localLiquidityTokenTrade(
        AddressZero,
        CURRENCY.DAI,
        1000e6,
        defaultLiquidityHaircut,
        portfolios.address
      )).to.emit(liquidation, "LiquidityTokenTrade")
        .withArgs(
          expectedRaise,
          1000e6
        );

      const amountToRaise = await portfolios._amount(); 
      expect(amountToRaise).to.equal(expectedRaise);
    });

    it("raises a partial amount with remainder at 18 decimals", async () => {
      const raiseNum = Math.trunc(1000 * 1.1 / (1 - 0.8));
      const remainderNum = Math.trunc(raiseNum * 0.2);
      const expectedRaise = parseEther(raiseNum.toString());
      const expectedRemainder = parseEther(remainderNum.toString());
      await portfolios.setRemainder(expectedRemainder);

      await expect(liquidation.localLiquidityTokenTrade(
        AddressZero,
        CURRENCY.DAI,
        parseEther("1000"),
        defaultLiquidityHaircut,
        portfolios.address
      )).to.emit(liquidation, "LiquidityTokenTrade")
        .withArgs(
          expectedRaise.sub(expectedRemainder),
          parseEther((1000 * 0.8).toString()) // With 20% remainder, we expect an 80% raise
        );

      const amountToRaise = await portfolios._amount(); 
      expect(amountToRaise).to.equal(expectedRaise);
    });

    it("raises a partial amount with remainder at 6 decimals", async () => {
      const raiseNum = Math.trunc(1000 * 1.1 / (1 - 0.8));
      const remainderNum = Math.trunc(raiseNum * 0.2);
      const expectedRaise = new BigNumber(raiseNum * 1e6);
      const expectedRemainder = new BigNumber(remainderNum * 1e6);
      await portfolios.setRemainder(expectedRemainder);

      await expect(liquidation.localLiquidityTokenTrade(
        AddressZero,
        CURRENCY.DAI,
        1000e6,
        defaultLiquidityHaircut,
        portfolios.address
      )).to.emit(liquidation, "LiquidityTokenTrade")
        .withArgs(
          expectedRaise.sub(expectedRemainder),
          new BigNumber((1000 * 0.8) * 1e6) // With 20% remainder, we expect an 80% raise
        );

      const amountToRaise = await portfolios._amount(); 
      expect(amountToRaise).to.equal(expectedRaise);
    });

    it("raises nothing with remainder at 18 decimals", async () => {
      const raiseNum = Math.trunc(1000 * 1.1 / (1 - 0.8));
      const remainderNum = raiseNum;
      const expectedRaise = parseEther(raiseNum.toString());
      const expectedRemainder = parseEther(remainderNum.toString());
      await portfolios.setRemainder(expectedRemainder);

      await expect(liquidation.localLiquidityTokenTrade(
        AddressZero,
        CURRENCY.DAI,
        parseEther("1000"),
        defaultLiquidityHaircut,
        portfolios.address
      )).to.emit(liquidation, "LiquidityTokenTrade")
        .withArgs(
          0,
          0 // With 100% remainder, we expect an 0% raise
        );

      const amountToRaise = await portfolios._amount(); 
      expect(amountToRaise).to.equal(expectedRaise);
    });
  });

  describe("calculatePostTradeFactors", async () => {
    it("full amount", async () => {
      const raiseNum = Math.trunc(1000 * 1.1 / (1 - 0.8));
      const haircutAmount = Math.trunc(raiseNum * 0.2);
      const incentiveAmount = Math.trunc(-(haircutAmount / 1.1 - haircutAmount));
      const expectedRaise = parseEther(raiseNum.toString());
      const expectedIncentive = parseEther(incentiveAmount.toString());
      const netCurrency = parseEther("2000");

      const results = await liquidation.calculatePostTradeFactors(
        expectedRaise,
        netCurrency,
        parseEther("1000"),
        parseEther("1000"),
        defaultLiquidityHaircut
      );

      expect(results[0]).to.equal(expectedIncentive.mul(-1));
      expect(results[1]).to.equal(expectedRaise.sub(expectedIncentive));
      expect(results[2]).to.equal(netCurrency.add(parseEther("1000"))); // Should be what is required
      expect(results[3]).to.equal(0);
    });

    it("partial amount", async () => {
      const raiseNum = Math.trunc(1000 * 1.1 / (1 - 0.8));
      const remainderNum = Math.trunc(raiseNum * 0.4);

      const haircutAmount = Math.trunc((raiseNum - remainderNum) * 0.2);
      const incentiveAmount = Math.trunc(-(haircutAmount / 1.1 - haircutAmount));
      const expectedRemainder = parseEther(remainderNum.toString());
      await portfolios.setRemainder(expectedRemainder);

      const expectedRaise = parseEther(raiseNum.toString());
      const expectedIncentive = parseEther(incentiveAmount.toString());
      const netCurrency = parseEther("2000");

      const results = await liquidation.calculatePostTradeFactors(
        expectedRaise.sub(expectedRemainder),
        netCurrency,
        parseEther("1000"),
        parseEther("600"),
        defaultLiquidityHaircut
      );

      expect(results[0]).to.equal(expectedIncentive.mul(-1));
      expect(results[1]).to.equal(expectedRaise.sub(expectedRemainder).sub(expectedIncentive));
      expect(results[2]).to.equal(netCurrency.add(parseEther("600"))); // Should add what we raised
      expect(results[3]).to.equal(parseEther("400"));
    });

    it("no amount", async () => {
      const raiseNum = Math.trunc(1000 * 1.1 / (1 - 0.8));
      const remainderNum = raiseNum;
      const expectedRemainder = parseEther(remainderNum.toString());
      await portfolios.setRemainder(expectedRemainder);

      const expectedRaise = parseEther(raiseNum.toString());
      const netCurrency = parseEther("2000");

      const results = await liquidation.calculatePostTradeFactors(
        expectedRaise.sub(expectedRemainder),
        netCurrency,
        parseEther("1000"),
        parseEther("0"),
        defaultLiquidityHaircut
      );

      expect(results[0]).to.equal(0);
      expect(results[1]).to.equal(0);
      expect(results[2]).to.equal(netCurrency);
      expect(results[3]).to.equal(parseEther("1000"));
    })
  });

  describe("calculate local currency to trade", async () => {

    it("required < maxDebt", async () => {
      const value = await liquidation.calculateLocalCurrencyToTrade(
        parseEther("100"),
        defaultLiquidationDiscount,
        parseEther("1.4"),
        parseEther("1000")
      );
      const expected = parseEther("100").mul(WeiPerEther).div(parseEther("0.34"));
      expect(value).to.equal(expected);
    });

    it("required > maxDebt", async () => {
      const value = await liquidation.calculateLocalCurrencyToTrade(
        parseEther("1000"),
        defaultLiquidationDiscount,
        parseEther("1.4"),
        parseEther("100")
      );
      expect(value).to.equal(parseEther("100"));
    });

  });

  describe("calculate token haircut", async () => {
    it("base case", async () => {
      const totalClaim = parseEther("1000");
      const postHaircut = totalClaim.mul(defaultLiquidityHaircut).div(WeiPerEther);
      const value = await liquidation.calculateLiquidityTokenHaircut(postHaircut, defaultLiquidityHaircut);
      expect(value).to.equal(totalClaim.sub(postHaircut));
    });

    it("small values", async () => {
      const totalClaim = new BigNumber(500);
      const postHaircut = totalClaim.mul(defaultLiquidityHaircut).div(WeiPerEther);
      const value = await liquidation.calculateLiquidityTokenHaircut(postHaircut, defaultLiquidityHaircut);
      expect(value).to.equal(totalClaim.sub(postHaircut));
    });
  });

  describe("calculate deposit to sell", async () => {
    it("base case", async () => {
      const value = await liquidation.calculateCollateralToSell(
        defaultLiquidationDiscount,
        parseEther("1000"),
        {
          rate: parseEther("0.01"),
          localCurrency: 1,
          collateralCurrency: 2,
          localDecimals: WeiPerEther,
          collateralDecimals: 1e6,
          localToETH: {
            rateOracle: chainlink.address,
            rateDecimals: WeiPerEther,
            mustInvert: false,
            buffer: parseEther("1.3")
          }
        }
      );

      expect(value).to.equal(10.6e6)
    });

    it("small values, convert down", async () => {
      // When converting down from 18 decimals to 6 we cannot sell under some amount of dust
      const value = await liquidation.calculateCollateralToSell(
        defaultLiquidationDiscount,
        parseEther("0.0001"),
        {
          rate: 0.01e6,
          localCurrency: 1,
          collateralCurrency: 2,
          localDecimals: WeiPerEther,
          collateralDecimals: 1e6,
          localToETH: {
            rateOracle: chainlink.address,
            rateDecimals: 1e6,
            mustInvert: false,
            buffer: parseEther("1.3")
          }
        }
      );

      expect(value).to.equal(1)
    });

    it("small values, convert up", async () => {
      // When converting down from 18 decimals to 6 we cannot sell under some amount of dust
      const value = await liquidation.calculateCollateralToSell(
        defaultLiquidationDiscount,
        0.0001e6,
        {
          rate: 0.01e6,
          localCurrency: 1,
          collateralCurrency: 2,
          localDecimals: 1e6,
          collateralDecimals: WeiPerEther,
          localToETH: {
            rateOracle: chainlink.address,
            rateDecimals: 1e6,
            mustInvert: false,
            buffer: parseEther("1.3")
          }
        }
      );

      expect(value).to.equal(1.06e12)
    });
  });

  describe("transfer collateral currency", async () => {
    const runTest = async (
      inputs: {
        balance: number,
        cashClaim: number,
        fCashValue: number,
        localRequired: number
      },
      outputs: {
        localToPurchase: number,
        collateralToSell: number,
        payerBalance: number,
        amountToRaise: number
      },
      revert = false
    ) => {
      const balance = new BigNumber(inputs.balance * 1e6);
      const transfer = {
        netLocalCurrencyLiquidator: 0,
        netLocalCurrencyPayer: 0,
        collateralTransfer: 0,
        payerCollateralBalance: balance
      }

      await portfolios.setClaim(inputs.cashClaim * 1e6, 0);
      const claim = (await portfolios.getClaim())[0];
      const available = balance.add(claim).add(new BigNumber(inputs.fCashValue * 1e6));
      const fc = {
        aggregate: -1, // unusued
        localNetAvailable: 0, // unused
        collateralNetAvailable: available,
        localCashClaim: 0, // unused
        collateralCashClaim: claim
      }
      
      if (revert) {
        await expect(liquidation.tradeCollateralCurrency(
          AddressZero,
          parseEther(inputs.localRequired.toString()),
          defaultLiquidityHaircut,
          defaultLiquidationDiscount,
          transfer,
          fc,
          defaultRateParams,
          portfolios.address
        )).to.be.reverted;

        return;
      }

      await expect(liquidation.tradeCollateralCurrency(
        AddressZero,
        parseEther(inputs.localRequired.toString()),
        defaultLiquidityHaircut,
        defaultLiquidationDiscount,
        transfer,
        fc,
        defaultRateParams,
        portfolios.address
      )).to.emit(liquidation, "TradeCollateralCurrency")
        .withArgs(
          parseEther(outputs.localToPurchase.toString()),
          parseEther(outputs.localToPurchase.toString()),
          outputs.collateralToSell * 1e6,
          outputs.payerBalance * 1e6
        );
      
      if (outputs.amountToRaise != 0) {
        expect(await portfolios._wasCalled()).to.be.true;
        expect(await portfolios._amount()).to.equal(outputs.amountToRaise * 1e6);
        await portfolios.setClaim((inputs.cashClaim - outputs.amountToRaise) * 1e6, 0);
        let postClaim = (await portfolios.getClaim())[0];
        let payerBalance = new BigNumber(outputs.payerBalance * 1e6);

        // Net currency available cannot dip below zero after trading
        expect(payerBalance.add(postClaim).add(new BigNumber(inputs.fCashValue * 1e6))).to.be.gte(0)
      } else {
        expect(await portfolios._wasCalled()).to.be.false;
      }
    }

    it("base case, not trading, balance is sufficient", async () => {
      await runTest(
        {
          balance: 110,
          cashClaim: 0,
          fCashValue: 0,
          localRequired: 100
        },
        {
          localToPurchase: 100,
          collateralToSell: 106,
          payerBalance: 4,
          amountToRaise: 0
        }
      )
    });

    describe("no trading", async () => {
      it("no trading, balance insufficient", async () => {
        await runTest(
          {
            balance: 106,
            cashClaim: 0,
            fCashValue: 0,
            localRequired: 200
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 0
          }
        )
      });

      it("no trading, balance negative", async () => {
        await portfolios.setRemainder(0);
        const balance = -106e6;
        const cashClaim = 0;
        const available = balance + cashClaim;

        await expect(liquidation.tradeCollateralCurrency(
          AddressZero,
          parseEther("200"),
          defaultLiquidityHaircut,
          defaultLiquidationDiscount,
          {
            netLocalCurrencyLiquidator: 0,
            netLocalCurrencyPayer: 0,
            collateralTransfer: 0,
            payerCollateralBalance: balance
          },
          {
            aggregate: -1,
            localCashClaim: 0,
            localNetAvailable: 0,
            collateralCashClaim: cashClaim,
            collateralNetAvailable: available
          },
          defaultRateParams,
          portfolios.address
        )).to.be.reverted;
      });

      it("no trading, balance sufficient, negative fCashValue", async () => {
        await runTest(
          {
            balance: 206,
            cashClaim: 0,
            fCashValue: -100,
            localRequired: 200
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 100,
            amountToRaise: 0
          }
        )
      });

      it("no trading, balance insufficient, negative fCashValue", async () => {
        await runTest(
          {
            balance: 153,
            cashClaim: 0,
            fCashValue: -100,
            localRequired: 200
          },
          {
            localToPurchase: 50,
            collateralToSell: 53,
            payerBalance: 100,
            amountToRaise: 0
          }
        )
      });

      it("no trading, balance sufficient, positive fCashValue", async () => {
        await runTest(
          {
            balance: 106,
            cashClaim: 0,
            fCashValue: 100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 0
          }
        )
      });

      it("no trading, balance insufficient, positive fCashValue", async () => {
        await runTest(
          {
            balance: 53,
            cashClaim: 0,
            fCashValue: 100,
            localRequired: 200
          },
          {
            localToPurchase: 50,
            collateralToSell: 53,
            payerBalance: 0,
            amountToRaise: 0
          }
        )
      });

      it("no trading, balance negative, positive fCashValue", async () => {
        await runTest(
          {
            balance: -100,
            cashClaim: 0,
            fCashValue: 200,
            localRequired: 200
          },
          {
            localToPurchase: 0,
            collateralToSell: 0,
            payerBalance: -100,
            amountToRaise: 0
          },
          true
        )
      });

      it("no trading, balance negative, positive fCashValue", async () => {
        await runTest(
          {
            balance: -10,
            cashClaim: 0,
            fCashValue: 200,
            localRequired: 200
          },
          {
            localToPurchase: 0,
            collateralToSell: 0,
            payerBalance: -100,
            amountToRaise: 0
          },
          true
        )
      });
    });


    describe("post haircut cash claim", async () => {

      it("no balance", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 140,
            fCashValue: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 106
          }
        )
      });

      it("partial balance", async () => {
        await runTest(
          {
            balance: 50,
            cashClaim: 140,
            fCashValue: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 56
          }
        )
      });

      it("negative balance", async () => {
        await runTest(
          {
            balance: -50,
            cashClaim: 200,
            fCashValue: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 156
          }
        )
      });

      it("sufficient balance", async () => {
        await runTest(
          {
            balance: 110,
            cashClaim: 200,
            fCashValue: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 4,
            amountToRaise: 0
          }
        )
      });

      it("negative fCashValue, no balance", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 210,
            fCashValue: -100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 84,
            amountToRaise: 190
          }
        )
      });

      it("negative fCashValue, sufficient balance", async () => {
        await runTest(
          {
            balance: 106,
            cashClaim: 210,
            fCashValue: -100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 0
          }
        )
      });

      it("negative fCashValue, partial balance", async () => {
        await runTest(
          {
            balance: 50,
            cashClaim: 210,
            fCashValue: -100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 56
          }
        )
      });

      it("negative fCashValue, negative balance", async () => {
        await runTest(
          {
            balance: -50,
            cashClaim: 300,
            fCashValue: -100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 156
          }
        )
      });

      it("positive fCashValue, no balance", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 110,
            fCashValue: 100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 106
          }
        )
      });

      it("positive fCashValue, sufficient balance", async () => {
        await runTest(
          {
            balance: 106,
            cashClaim: 110,
            fCashValue: 100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 0
          }
        )
      });

      it("positive fCashValue, partial balance", async () => {
        await runTest(
          {
            balance: 50,
            cashClaim: 110,
            fCashValue: 100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 56
          }
        )
      });

      it("positive fCashValue above negative balance", async () => {
        await runTest(
          {
            balance: -50,
            cashClaim: 200,
            fCashValue: 100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: -50,
            amountToRaise: 106
          }
        )
      });

      it("positive fCashValue below negative balance", async () => {
        await runTest(
          {
            balance: -50,
            cashClaim: 200,
            fCashValue: 10,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: -10,
            amountToRaise: 146
          }
        )
      });
    });

    describe("trading with sufficient pre haircut cash claim", async () => {
      it("no balance", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 120,
            fCashValue: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 106
          }
        )
      });

      it("partial balance", async () => {
        await runTest(
          {
            balance: 1,
            cashClaim: 120,
            fCashValue: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 105
          }
        )
      });

      it("negative balance", async () => {
        await runTest(
          {
            balance: -1,
            cashClaim: 120,
            fCashValue: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 107
          }
        )
      });

      it("sufficient balance", async () => {
        await runTest(
          {
            balance: 110,
            cashClaim: 120,
            fCashValue: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 4,
            amountToRaise: 0
          }
        )
      });

      it("no balance, negative fCashValue", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 130,
            fCashValue: -20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 4,
            amountToRaise: 110
          }
        )
      });

      it("partial balance, negative fCashValue", async () => {
        await runTest(
          {
            balance: 1,
            cashClaim: 129,
            fCashValue: -20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 4,
            amountToRaise: 109
          }
        )
      });

      it("negative balance, negative fCashValue", async () => {
        await runTest(
          {
            balance: -1,
            cashClaim: 131,
            fCashValue: -20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 4,
            amountToRaise: 111
          }
        )
      });


      it("sufficient balance, negative fCashValue", async () => {
        await runTest(
          {
            balance: 100,
            cashClaim: 26,
            fCashValue: -20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 20,
            amountToRaise: 26
          }
        )
      });

      it("sufficient balance, positive fCashValue", async () => {
        await runTest(
          {
            balance: 100,
            cashClaim: 26,
            fCashValue: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 6
          }
        )
      });

      it("partial balance, positive fCashValue", async () => {
        await runTest(
          {
            balance: 1,
            cashClaim: 129,
            fCashValue: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 105
          }
        )
      });

      it("partial balance, positive fCashValue", async () => {
        await runTest(
          {
            balance: -21,
            cashClaim: 129,
            fCashValue: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: -20,
            amountToRaise: 107
          }
        )
      });

      it("no balance, positive fCashValue", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 110,
            fCashValue: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 106
          }
        )
      });
    });

    describe("trading with insufficient pre haircut cash claim", async () => {

      it("no balance", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 106,
            fCashValue: 0,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 106
          }
        )
      });

      it("partial balance", async () => {
        await runTest(
          {
            balance: 6,
            cashClaim: 100,
            fCashValue: 0,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 100
          }
        )
      });

      it("negative balance", async () => {
        await runTest(
          {
            balance: -47,
            cashClaim: 100,
            fCashValue: 0,
            localRequired: 120
          },
          {
            localToPurchase: 50,
            collateralToSell: 53,
            payerBalance: 0,
            amountToRaise: 100
          }
        )
      });

      it("sufficient balance", async () => {
        await runTest(
          {
            balance: 150,
            cashClaim: 100,
            fCashValue: 0,
            localRequired: 120
          },
          {
            localToPurchase: 120,
            collateralToSell: 127.2,
            payerBalance: 22.8,
            amountToRaise: 0
          }
        )
      });

      it("no balance, negative fCashValue", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 126,
            fCashValue: -20,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 20,
            amountToRaise: 126
          }
        )
      });

      it("partial balance, negative fCashValue", async () => {
        await runTest(
          {
            balance: 1,
            cashClaim: 125,
            fCashValue: -20,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 20,
            amountToRaise: 125
          }
        )
      });

      it("negative balance, negative fCashValue", async () => {
        await runTest(
          {
            balance: -1,
            cashClaim: 127,
            fCashValue: -20,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 20,
            amountToRaise: 127
          }
        )
      });

      it("sufficient balance, negative fCashValue", async () => {
        await runTest(
          {
            balance: 140,
            cashClaim: 127,
            fCashValue: -20,
            localRequired: 120
          },
          {
            localToPurchase: 120,
            collateralToSell: 127.2,
            payerBalance: 12.8,
            amountToRaise: 0
          }
        );
      });;

      it("no balance, positive fCashValue", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 110,
            fCashValue: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 106
          }
        )
      });

      it("partial balance, positive fCashValue", async () => {
        await runTest(
          {
            balance: 1,
            cashClaim: 105,
            fCashValue: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: 0,
            amountToRaise: 105
          }
        )
      });

      it("negative balance, positive fCashValue", async () => {
        await runTest(
          {
            balance: -41,
            cashClaim: 127,
            fCashValue: 20,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            collateralToSell: 106,
            payerBalance: -20,
            amountToRaise: 127
          }
        )
      });

      it("sufficient balance, positive fCashValue", async () => {
        await runTest(
          {
            balance: 140,
            cashClaim: 127,
            fCashValue: 20,
            localRequired: 120
          },
          {
            localToPurchase: 120,
            collateralToSell: 127.2,
            payerBalance: 12.8,
            amountToRaise: 0
          }
        );
      });
    });
  });

});