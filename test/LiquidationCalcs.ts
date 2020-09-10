import chai from "chai";
import { solidity } from "ethereum-waffle";
import { Wallet, Contract } from 'ethers';
import { wallets, CURRENCY } from './fixtures';
import { SwapnetDeployer } from '../scripts/SwapnetDeployer';
import MockLiquidationArtifact from '../build/MockLiquidation.json';
import { MockLiquidation } from '../typechain/MockLiquidation';
import MockPortfoliosArtifact from '../build/MockPortfolios.json';
import { MockPortfolios } from '../typechain/MockPortfolios';
import { AddressZero, WeiPerEther } from 'ethers/constants';
import { BigNumber, parseEther } from 'ethers/utils';

chai.use(solidity);
const { expect } = chai;

describe("Liquidation Calculations", () => {
  let owner: Wallet;
  let liquidation: MockLiquidation;
  let portfolios: MockPortfolios;
  const defaultLiquidityHaircut = parseEther("0.8");
  const defaultRepoIncentive = parseEther("1.10");
  const defaultLiquidationDiscount = parseEther("1.06");

  beforeEach(async () => {
    owner = wallets[0];
    const libraries = new Map<string, Contract>();

    libraries.set("Liquidation", (await SwapnetDeployer.deployContract(
        owner,
        SwapnetDeployer.loadArtifact("Liquidation"),
        []
    )));

    liquidation = await SwapnetDeployer.deployContract(
      owner,
      MockLiquidationArtifact,
      []
    ) as MockLiquidation;

    portfolios = await SwapnetDeployer.deployContract(
      owner,
      MockPortfoliosArtifact,
      []
    ) as MockPortfolios;

    await portfolios.setHaircut(defaultLiquidityHaircut);
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
        defaultRepoIncentive,
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
        defaultRepoIncentive,
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
        defaultRepoIncentive,
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
        defaultRepoIncentive,
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
        defaultRepoIncentive,
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
      const value = await liquidation.calculateDepositToSell(
        parseEther("0.01"),
        WeiPerEther,
        defaultLiquidationDiscount,
        parseEther("1000"),
        WeiPerEther,
        1e6
      );

      expect(value).to.equal(10.6e6)
    });

    it("small values, convert down", async () => {
      // When converting down from 18 decimals to 6 we cannot sell under some amount of dust
      const value = await liquidation.calculateDepositToSell(
        0.01e6,
        1e6,
        defaultLiquidationDiscount,
        parseEther("0.0001"),
        WeiPerEther,
        1e6
      );

      expect(value).to.equal(1)
    });

    it("small values, convert up", async () => {
      // When converting down from 18 decimals to 6 we cannot sell under some amount of dust
      const value = await liquidation.calculateDepositToSell(
        0.01e6,
        1e6,
        defaultLiquidationDiscount,
        0.0001e6,
        1e6,
        WeiPerEther
      );

      expect(value).to.equal(1.06e12)
    });
  });

  describe("transfer deposit currency", async () => {
    // Keep rate 1-1 to make things easy
    const rateParams = {
      rate: 1e6,
      rateDecimals: 1e6,
      localDecimals: WeiPerEther,
      depositDecimals: 1e6
    }

    const depositParameters = {
      // localCurrencyRequired 
      // depositCurrencyCashClaim
      // depositCurrencyAvailable
      localCurrencyAvailable: 0, // This is unused in the calculations, required maxes out at available
      depositCurrency: CURRENCY.ETH,
      discountFactor: defaultLiquidationDiscount,
      liquidityHaircut: defaultLiquidityHaircut,
    }

    const runTest = async (
      inputs: {
        balance: number,
        cashClaim: number,
        requirement: number,
        localRequired: number
      },
      outputs: {
        localToPurchase: number,
        depositToSell: number,
        payerBalance: number,
        amountToRaise: number
      }
    ) => {
      const balance = new BigNumber(inputs.balance * 1e6);
      await portfolios.setClaim(inputs.cashClaim * 1e6, 0);
      const claim = (await portfolios.getClaim())[0];

      const available = balance.add(claim).sub(new BigNumber(inputs.requirement * 1e6));

      await expect(liquidation.tradeDepositCurrency(
        AddressZero,
        balance,
        {
          ...depositParameters,
          localCurrencyRequired: parseEther(inputs.localRequired.toString()),
          depositCurrencyCashClaim: claim,
          depositCurrencyAvailable: available,
          Portfolios: portfolios.address
        },
        rateParams
      )).to.emit(liquidation, "TradeDepositCurrency")
        .withArgs(
          parseEther(outputs.localToPurchase.toString()),
          outputs.depositToSell * 1e6,
          outputs.payerBalance * 1e6
        );
      
      if (outputs.amountToRaise != 0) {
        expect(await portfolios._wasCalled()).to.be.true;
        expect(await portfolios._amount()).to.equal(outputs.amountToRaise * 1e6);
        await portfolios.setClaim((inputs.cashClaim - outputs.amountToRaise) * 1e6, 0);
        let postClaim = (await portfolios.getClaim())[0];
        let payerBalance = new BigNumber(outputs.payerBalance * 1e6);

        // Net currency available cannot dip below zero after trading
        expect(payerBalance.add(postClaim)).to.be.gte(new BigNumber(inputs.requirement * 1e6))
      } else {
        expect(await portfolios._wasCalled()).to.be.false;
      }
    }

    it("base case, not trading, balance is sufficient", async () => {
      await runTest(
        {
          balance: 110,
          cashClaim: 0,
          requirement: 0,
          localRequired: 100
        },
        {
          localToPurchase: 100,
          depositToSell: 106,
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
            requirement: 0,
            localRequired: 200
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
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

        await expect(liquidation.tradeDepositCurrency(
          AddressZero,
          balance,
          {
            ...depositParameters,
            localCurrencyRequired: parseEther("200"),
            depositCurrencyCashClaim: cashClaim,
            depositCurrencyAvailable: available,
            Portfolios: portfolios.address
          },
          rateParams
        )).to.be.reverted;
      });

      it("no trading, balance sufficient, requirement", async () => {
        await runTest(
          {
            balance: 206,
            cashClaim: 0,
            requirement: 100,
            localRequired: 200
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 100,
            amountToRaise: 0
          }
        )
      });

      it("no trading, balance insufficient, requirement", async () => {
        await runTest(
          {
            balance: 153,
            cashClaim: 0,
            requirement: 100,
            localRequired: 200
          },
          {
            localToPurchase: 50,
            depositToSell: 53,
            payerBalance: 100,
            amountToRaise: 0
          }
        )
      });
    });


    describe("post haircut cash claim", async () => {

      it("no balance", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 140,
            requirement: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
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
            requirement: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
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
            requirement: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
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
            requirement: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 4,
            amountToRaise: 0
          }
        )
      });

      it("requirement, no balance", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 210,
            requirement: 100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 84,
            amountToRaise: 190
          }
        )
      });

      it("requirement, sufficient balance", async () => {
        await runTest(
          {
            balance: 106,
            cashClaim: 210,
            requirement: 100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 0,
            amountToRaise: 0
          }
        )
      });

      it("requirement, partial balance", async () => {
        await runTest(
          {
            balance: 50,
            cashClaim: 210,
            requirement: 100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 0,
            amountToRaise: 56
          }
        )
      });

      it("requirement, negative balance", async () => {
        await runTest(
          {
            balance: -50,
            cashClaim: 300,
            requirement: 100,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 0,
            amountToRaise: 156
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
            requirement: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
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
            requirement: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
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
            requirement: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
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
            requirement: 0,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 4,
            amountToRaise: 0
          }
        )
      });

      it("no balance, requirement", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 130,
            requirement: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 4,
            amountToRaise: 110
          }
        )
      });

      it("partial balance, requirement", async () => {
        await runTest(
          {
            balance: 1,
            cashClaim: 129,
            requirement: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 4,
            amountToRaise: 109
          }
        )
      });

      it("negative balance, requirement", async () => {
        await runTest(
          {
            balance: -1,
            cashClaim: 131,
            requirement: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 4,
            amountToRaise: 111
          }
        )
      });


      it("sufficient balance, requirement", async () => {
        await runTest(
          {
            balance: 100,
            cashClaim: 26,
            requirement: 20,
            localRequired: 100
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 20,
            amountToRaise: 26
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
            requirement: 0,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
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
            requirement: 0,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
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
            requirement: 0,
            localRequired: 120
          },
          {
            localToPurchase: 50,
            depositToSell: 53,
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
            requirement: 0,
            localRequired: 120
          },
          {
            localToPurchase: 120,
            depositToSell: 127.2,
            payerBalance: 22.8,
            amountToRaise: 0
          }
        )
      });

      it("no balance, requirement", async () => {
        await runTest(
          {
            balance: 0,
            cashClaim: 126,
            requirement: 20,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 20,
            amountToRaise: 126
          }
        )
      });

      it("partial balance, requirement", async () => {
        await runTest(
          {
            balance: 1,
            cashClaim: 125,
            requirement: 20,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 20,
            amountToRaise: 125
          }
        )
      });

      it("negative balance, requirement", async () => {
        await runTest(
          {
            balance: -1,
            cashClaim: 127,
            requirement: 20,
            localRequired: 120
          },
          {
            localToPurchase: 100,
            depositToSell: 106,
            payerBalance: 20,
            amountToRaise: 127
          }
        )
      });

      it("sufficient balance, requirement", async () => {
        await runTest(
          {
            balance: 140,
            cashClaim: 127,
            requirement: 20,
            localRequired: 120
          },
          {
            localToPurchase: 120,
            depositToSell: 127.2,
            payerBalance: 12.8,
            amountToRaise: 0
          }
        );
      });
    });
  });

});