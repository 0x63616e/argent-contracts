const { assert, expect } = require("chai");
const utils = require("../utilities.js");
const { getRouteParams, getParaswappoolData, getSimpleSwapParams, getRoutesForExchange } = require("./sell-helper.js");

const { ZERO_ADDRESS, ETH_TOKEN, encodeTransaction } = utils;
const PARASWAP_ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const UNIV3_FEE = 3000;

module.exports.makeParaswapHelpers = ({
  argent,
  wallet,
  tokens,
  paraswap,
  paraswapProxy,
  unauthorisedAdapter,
  adapterAddresses,
  targetExchangeAddresses,
  exchangeContracts,
  uniswapForkData,
  uniswapV1Factory,
  zeroExV2Proxy,
  marketMaker,
  other,
}) => {
  const { module, manager, owner, relayer } = argent;
  const { tokenA, tokenB, tokenC } = tokens;
  const {
    paraswapUniV2Router, uniswapV3Router, uniswapV1Exchanges, zeroExV2TargetExchange, zeroExV4TargetExchange, curvePool, weth
  } = exchangeContracts;

  function getTokenContract(tokenAddress) {
    if (tokenAddress === tokenA.address) {
      return tokenA;
    }
    if (tokenAddress === tokenB.address) {
      return tokenB;
    }
    if (tokenAddress === tokenC.address) {
      return tokenC;
    }
    if (tokenAddress === weth.address) {
      return weth;
    }
    return { address: PARASWAP_ETH_TOKEN };
  }

  async function getBalance(tokenAddress, _wallet) {
    if (tokenAddress === PARASWAP_ETH_TOKEN) {
      return utils.getBalance(_wallet.address);
    }
    return getTokenContract(tokenAddress).balanceOf(_wallet.address);
  }

  const multiCall = async (transactions, { errorReason = null }) => {
    const receipt = await manager.relay(
      module, "multiCall", [wallet.address, transactions], wallet, [owner], 0, ETH_TOKEN, relayer
    );
    const { success, error } = utils.parseRelayReceipt(receipt);
    if (errorReason) {
      assert.isFalse(success, "multiCall should have failed");
      assert.equal(error, errorReason);
    } else {
      assert.isTrue(success, `multiCall failed: "${error}"`);
    }
  };

  function getPath({ fromToken, toToken, routes, useUnauthorisedAdapter = false, useUnauthorisedTargetExchange = false }) {
    const exchanges = {
      uniswap: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.uniswap,
      uniswapv2: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.uniswapV2,
      uniswapv3: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.uniswapV3,
      sushiswap: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.sushiswap,
      linkswap: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.linkswap,
      defiswap: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.defiswap,
      paraswappoolv2: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.zeroexV2,
      paraswappoolv4: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.zeroexV4,
      curve: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.curve,
      weth: useUnauthorisedAdapter ? unauthorisedAdapter.address : adapterAddresses.weth,
    };
    const targetExchanges = {
      uniswap: useUnauthorisedTargetExchange ? other : uniswapV1Factory.address,
      uniswapv2: ZERO_ADDRESS,
      uniswapv3: useUnauthorisedTargetExchange ? other : uniswapV3Router.address,
      sushiswap: ZERO_ADDRESS,
      linkswap: ZERO_ADDRESS,
      defiswap: ZERO_ADDRESS,
      paraswappoolv2: useUnauthorisedTargetExchange ? other : targetExchangeAddresses.zeroexV2,
      paraswappoolv4: useUnauthorisedTargetExchange ? other : targetExchangeAddresses.zeroexV4,
      curve: useUnauthorisedTargetExchange ? other : targetExchangeAddresses.curve[0],
      weth: ZERO_ADDRESS
    };
    return [{
      to: toToken,
      totalNetworkFee: 0,
      routes: routes.map((route) => getRouteParams(fromToken, toToken, route, exchanges, targetExchanges)),
    }];
  }

  function getMultiSwapData({
    fromToken,
    toToken,
    fromAmount,
    toAmount,
    beneficiary,
    useUnauthorisedAdapter = false,
    useUnauthorisedTargetExchange = false,
    routes
  }) {
    const path = getPath({ fromToken, toToken, routes, useUnauthorisedAdapter, useUnauthorisedTargetExchange });
    return paraswap.contract.methods.multiSwap({
      fromToken, fromAmount, toAmount, expectedAmount: 0, beneficiary, referrer: "abc", useReduxToken: false, path
    }).encodeABI();
  }

  function getMegaSwapData({
    fromToken,
    toToken,
    fromAmount,
    toAmount,
    beneficiary,
    useUnauthorisedAdapter,
    useUnauthorisedTargetExchange,
    routes
  }) {
    const path = getPath({ fromToken, toToken, routes, useUnauthorisedAdapter, useUnauthorisedTargetExchange });
    return paraswap.contract.methods.megaSwap({
      fromToken,
      fromAmount,
      toAmount,
      expectedAmount: 0,
      beneficiary,
      referrer: "abc",
      useReduxToken: false,
      path: [{ fromAmountPercent: 10000, path }]
    }).encodeABI();
  }

  function getSimpleSwapExchangeCallParams({ exchange, fromToken, toToken, fromAmount, toAmount, maker }) {
    let targetExchange;
    let swapMethod;
    let swapParams;
    let proxy = null;
    let convertWeth = false;

    if (exchange === "uniswapv2") {
      targetExchange = paraswapUniV2Router;
      swapMethod = "swap";
      swapParams = [fromAmount, toAmount, [fromToken, toToken]];
    } else if (exchange === "uniswapv3") {
      targetExchange = uniswapV3Router;
      swapMethod = "exactInputSingle";
      swapParams = [{
        tokenIn: fromToken,
        tokenOut: toToken,
        fee: UNIV3_FEE,
        recipient: paraswap.address,
        deadline: 99999999999,
        amountIn: fromAmount,
        amountOutMinimum: toAmount,
        sqrtPriceLimitX96: 0
      }];
    } else if (exchange === "uniswap" || exchange === "uniswapLike") {
      if (fromToken === PARASWAP_ETH_TOKEN) {
        targetExchange = uniswapV1Exchanges[toToken];
        swapMethod = "ethToTokenSwapInput";
        swapParams = [1, 99999999999];
      } else {
        targetExchange = uniswapV1Exchanges[fromToken];
        if (toToken === PARASWAP_ETH_TOKEN) {
          swapMethod = "tokenToEthSwapInput";
          swapParams = [fromAmount, 1, 99999999999];
        } else {
          swapMethod = "tokenToTokenSwapInput";
          swapParams = [fromAmount, 1, 1, 99999999999, toToken];
        }
      }
    } else if (exchange === "zeroexv2") {
      proxy = zeroExV2Proxy;
      targetExchange = zeroExV2TargetExchange;
      swapMethod = "marketSellOrdersNoThrow";
      const { orders, signatures } = getParaswappoolData({ maker, version: 2 });
      swapParams = [orders, 0, signatures];
      convertWeth = toToken === PARASWAP_ETH_TOKEN;
    } else if (exchange === "zeroexv4") {
      targetExchange = zeroExV4TargetExchange;
      swapMethod = "fillRfqOrder";
      convertWeth = toToken === PARASWAP_ETH_TOKEN;
      const { order, signature } = getParaswappoolData({ fromToken, toToken, maker, version: 4 });
      swapParams = [order, signature, 0];
    } else if (exchange === "curve") {
      targetExchange = curvePool;
      swapMethod = "exchange";
      swapParams = [0, 1, fromAmount, toAmount];
    } else if (exchange === "weth") {
      targetExchange = weth;
      swapMethod = fromToken === PARASWAP_ETH_TOKEN ? "deposit" : "withdraw";
      swapParams = fromToken === PARASWAP_ETH_TOKEN ? [] : [toAmount];
    }

    return { targetExchange, swapMethod, swapParams, proxy, convertWeth, augustus: paraswap, weth };
  }

  function getSimpleSwapData({ fromToken, toToken, fromAmount, toAmount, exchange, beneficiary, maker = marketMaker }) {
    const simpleSwapParams = getSimpleSwapParams({
      ...getSimpleSwapExchangeCallParams({ exchange, fromToken, toToken, fromAmount, toAmount, maker }),
      fromTokenContract: getTokenContract(fromToken),
      toTokenContract: getTokenContract(toToken),
      fromAmount,
      toAmount,
      beneficiary
    });
    return paraswap.contract.methods.simpleSwap(...simpleSwapParams).encodeABI();
  }

  function getSwapOnUniswapData({ fromToken, toToken, fromAmount, toAmount }) {
    return paraswap.contract.methods.swapOnUniswap(fromAmount, toAmount, [fromToken, toToken], 0).encodeABI();
  }

  function getSwapOnUniswapForkData({ fromToken, toToken, fromAmount, toAmount }) {
    return paraswap.contract.methods.swapOnUniswapFork(
      uniswapForkData.factory, uniswapForkData.initCode, fromAmount, toAmount, [fromToken, toToken], 0
    ).encodeABI();
  }

  async function testTrade({
    method,
    fromToken,
    toToken,
    beneficiary = ZERO_ADDRESS,
    fromAmount = web3.utils.toWei("0.01"),
    toAmount = 1,
    useUnauthorisedAdapter = false,
    useUnauthorisedTargetExchange = false,
    errorReason = null,
    exchange = "uniswapLike"
  }) {
    const beforeFrom = await getBalance(fromToken, wallet);
    const beforeTo = await getBalance(toToken, wallet);
    expect(beforeFrom).to.be.gte.BN(fromAmount); // wallet should have enough of fromToken
    const transactions = [];

    // token approval if necessary
    if (fromToken !== PARASWAP_ETH_TOKEN) {
      const token = getTokenContract(fromToken);
      const approveData = token.contract.methods.approve(paraswapProxy, fromAmount).encodeABI();
      transactions.push(encodeTransaction(fromToken, 0, approveData));
    }

    // token swap
    let swapData;
    const routes = getRoutesForExchange({ fromToken, toToken, maker: marketMaker, exchange });
    if (method === "multiSwap") {
      swapData = getMultiSwapData({
        fromToken, toToken, fromAmount, toAmount, beneficiary, routes, useUnauthorisedAdapter, useUnauthorisedTargetExchange
      });
    } else if (method === "megaSwap") {
      swapData = getMegaSwapData({
        fromToken, toToken, fromAmount, toAmount, beneficiary, routes, useUnauthorisedAdapter, useUnauthorisedTargetExchange
      });
    } else if (method === "simpleSwap") {
      swapData = getSimpleSwapData({ fromToken, toToken, fromAmount, toAmount, beneficiary, exchange });
    } else if (method === "swapOnUniswap") {
      swapData = getSwapOnUniswapData({ fromToken, toToken, fromAmount, toAmount });
    } else if (method === "swapOnUniswapFork") {
      swapData = getSwapOnUniswapForkData({ fromToken, toToken, fromAmount, toAmount });
    } else {
      throw new Error("Invalid method");
    }
    const value = fromToken === PARASWAP_ETH_TOKEN ? fromAmount : 0;
    transactions.push(encodeTransaction(paraswap.address, value, swapData));

    await multiCall(transactions, { errorReason });
    if (!errorReason) {
      const afterFrom = await getBalance(fromToken, wallet);
      const afterTo = await getBalance(toToken, wallet);
      expect(beforeFrom).to.be.gt.BN(afterFrom);
      expect(afterTo).to.be.gt.BN(beforeTo);
    }
  }

  return { testTrade, multiCall, getSimpleSwapData, getMultiSwapData, getSimpleSwapExchangeCallParams };
};
