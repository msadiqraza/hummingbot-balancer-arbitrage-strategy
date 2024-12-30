import {
  Address,
  BalancerApi,
  Path,
  Slippage,
  Swap,
  SwapBuildCallInput,
  SwapInput,
  SwapKind,
  Token as Token$1,
  TokenAmount,
} from '@balancer/sdk';

import { SwapInfo, SwapV2 } from '@balancer-labs/sdk';

import { Fraction } from '@uniswap/sdk';
import { Currency, CurrencyAmount, Token } from '@uniswap/sdk-core';
import {
  BigNumber,
  ContractInterface,
  ContractTransaction,
  Transaction,
  Wallet,
} from 'ethers';
import { getAddress } from 'ethers/lib/utils';
import * as math from 'mathjs';
import { Avalanche } from '../../chains/avalanche/avalanche';
import { Ethereum } from '../../chains/ethereum/ethereum';
import { EVMTxBroadcaster } from '../../chains/ethereum/evm.broadcaster';
import { Polygon } from '../../chains/polygon/polygon';
import { Uniswapish, UniswapishTrade } from '../../services/common-interfaces';
import { percentRegexp } from '../../services/config-manager-v2';
import {
  InitializationError,
  SERVICE_UNITIALIZED_ERROR_CODE,
  SERVICE_UNITIALIZED_ERROR_MESSAGE,
  UniswapishPriceError,
} from '../../services/error-handler';
import { logger } from '../../services/logger';
import { isFractionString } from '../../services/validators';
import { BalancerConfig } from './balancer.config';
// import { EVMTxBroadcaster } from '../../chains/ethereum/evm.broadcaster';

export interface BalancerSwap {
  swapInfo: SwapInfo;
  paths: Path[];
  maxSlippage: number;
  deadline: string;
  kind: SwapKind;
}

export interface BalancerTrade {
  swap: BalancerSwap;
  executionPrice: Fraction;
}

interface OverrideParams {
  gasLimit: string | number;
  value: number;
  nonce: number | undefined;
  maxFeePerGas?: BigNumber | undefined;
  maxPriorityFeePerGas?: BigNumber | undefined;
  gasPrice?: string;
}

export class Balancer implements Uniswapish {
  private static _instances: { [name: string]: Balancer };
  private _chain: Ethereum | Polygon | Avalanche;
  private _config: typeof BalancerConfig.config;
  private tokenList: Record<string, Token> = {};
  private _ready: boolean = false;
  public gasLimitEstimate: any;
  public router: any;
  public balancer: BalancerApi;
  public routerAbi: any[];
  public ttl: any;
  public amount: number;
  private rpcUrl: string;
  public inToken: Address = `0x0`;
  public outToken: Address = `0x0`;
  private requestCount: number = 0;
  private ganacheRpcUrl: string;

  private constructor(chain: string, network: string) {
    this._config = BalancerConfig.config;
    if (chain === 'ethereum') {
      this._chain = Ethereum.getInstance(network);
    } else if (chain === 'avalanche') {
      this._chain = Avalanche.getInstance(network);
    } else if (chain === 'polygon') {
      this._chain = Polygon.getInstance(network);
    } else throw Error('Chain not supported.');

    this.rpcUrl = `https://api-v3.balancer.fi/`;
    this.ganacheRpcUrl = `http://host.docker.internal:7545`;
    this.balancer = new BalancerApi(this.rpcUrl, this._chain.chainId);
    this.routerAbi = [];
    this.ttl = this._config.ttl;
    this.gasLimitEstimate = this._config.gasLimitEstimate;
    this.amount = 0;
  }

  // problematic
  public static getInstance(chain: string, network: string): Balancer {
    if (Balancer._instances === undefined) {
      Balancer._instances = {};
    }
    if (!(chain + network in Balancer._instances)) {
      Balancer._instances[chain + network] = new Balancer(chain, network);
    }

    return Balancer._instances[chain + network];
  }

  public async init() {
    if (!this._chain.ready())
      throw new InitializationError(
        SERVICE_UNITIALIZED_ERROR_MESSAGE(this._chain.chainName),
        SERVICE_UNITIALIZED_ERROR_CODE,
      );
    for (const token of this._chain.storedTokenList) {
      this.tokenList[token.address] = new Token(
        this._chain.chainId,
        `0x${token.address.slice(2)}`,
        token.decimals,
        token.symbol,
        token.name,
      );
    }
    this._ready = true;
  }

  public logRequest(): number {
    return this.requestCount++;
  }

  /*
   * Given a token's address, return the connector's native representation of
   * the token.
   *
   * @param address Token address
   */
  public getTokenByAddress(address: string): Token {
    return this.tokenList[getAddress(address)];
  }

  /**
   * Determines if the connector is ready.
   */
  public ready(): boolean {
    return this._ready;
  }

  /**
   * Gets the allowed slippage percent from the optional parameter or the value
   * in the configuration.
   *
   * @param allowedSlippageStr (Optional) should be of the form '1/10'.
   */
  public getAllowedSlippage(allowedSlippageStr?: string): number {
    if (allowedSlippageStr != null && isFractionString(allowedSlippageStr)) {
      const fractionSplit = allowedSlippageStr.split('/');
      return Number(
        ((Number(fractionSplit[0]) / Number(fractionSplit[1])) * 100).toFixed(
          0,
        ),
      );
    }

    const allowedSlippage = this._config.allowedSlippage;
    const matches = allowedSlippage.match(percentRegexp);
    if (matches)
      return Number(
        ((Number(matches[1]) / Number(matches[2])) * 100).toFixed(0),
      );
    throw new Error(
      'Encountered a malformed percent string in the config for ALLOWED_SLIPPAGE.',
    );
  }

  /**
   * Given the amount of `baseToken` desired to acquire from a transaction,
   * calculate the amount of `quoteToken` needed for the transaction.
   *
   * This is typically used for calculating token buy prices.
   *
   * @param quoteToken Token input for the transaction
   * @param baseToken Token output from the transaction
   * @param amount Amount of `baseToken` desired from the transaction
   * @param allowedSlippage (Optional) Fraction in string representing the allowed slippage for this transaction
   */
  async estimateBuyTrade(
    quoteToken: Token,
    baseToken: Token,
    amount: BigNumber,
    allowedSlippage?: string,
    poolId?: string,
  ) {
    logger.info(
      `Fetching pair data for ${quoteToken.address}-${baseToken.address}. BUY`,
    );

    this.inToken = `0x${quoteToken.address.slice(2)}`;
    this.outToken = `0x${baseToken.address.slice(2)}`;
    const swapKind = SwapKind.GivenOut

    if (poolId) {
      await this.balancer.pools.fetchPoolState(poolId);
    } else {
      console.log('poolId is required to fetch pool state');
    }

    const token$1 = new Token$1(
      this._chain.chainId,
      this.outToken,
      quoteToken.decimals,
    );

    const swapAmount = TokenAmount.fromRawAmount(
      token$1,
      `${amount.toString()}`,
    );

    const infoParams = {
      chainId: this._chain.chainId,
      tokenIn: this.inToken,
      tokenOut: this.outToken,
      swapKind: swapKind,
      swapAmount: swapAmount,
    };

    const paths =
      await this.balancer.sorSwapPaths.fetchSorSwapPaths(infoParams);

    if (paths.length === 0) {
      throw new UniswapishPriceError(
        `No pool found for ${quoteToken.address} to ${baseToken.address}.`,
      );
    }

    const bestPath = paths[0];
    const outputAmount = bestPath.outputAmountRaw;
    const inputAmount = bestPath.inputAmountRaw;

    const marketSp = math.divide(
      math.fraction(outputAmount.toString()),
      math.fraction(inputAmount.toString()),
    ) as math.Fraction;

    const executionPrice = new Fraction(
      marketSp.d.toString(),
      marketSp.n.toString(),
    );
    const tokenAddresses = paths[0].tokens.map(
      (token: { address: Address }) => token.address,
    );

    const swaps: SwapV2[] = paths[0].pools.map(
      (pool: Address, index: number) => ({
        poolId: pool as string,
        assetInIndex: index,
        assetOutIndex: index + 1 < tokenAddresses.length ? index + 1 : index,
        amount: paths[0].inputAmountRaw.toString(),
        userData: '0x',
        returnAmount: paths[0].outputAmountRaw.toString(),
      }),
    );

    const swapInfo: SwapInfo = {
      tokenAddresses: tokenAddresses,
      swaps: swaps,
      swapAmount: BigNumber.from(inputAmount),
      swapAmountForSwaps: BigNumber.from(inputAmount),
      returnAmount: BigNumber.from(outputAmount),
      returnAmountFromSwaps: BigNumber.from(outputAmount),
      returnAmountConsideringFees: BigNumber.from(outputAmount),
      tokenIn: tokenAddresses[0],
      tokenInForSwaps: tokenAddresses[0],
      tokenOut: tokenAddresses[tokenAddresses.length - 1],
      tokenOutFromSwaps: tokenAddresses[tokenAddresses.length - 1],
      marketSp: marketSp.toString(),
    };

    const result = {
      trade: {
        swap: {
          swapInfo: swapInfo,
          paths: paths,
          maxSlippage: this.getAllowedSlippage(allowedSlippage),
          deadline: '0', // updated before trade execution
          kind: swapKind,
        },
        executionPrice,
      },
      expectedAmount: CurrencyAmount.fromRawAmount(
        <Currency>quoteToken,
        outputAmount.toString(),
      ),
    };

    console.log(JSON.stringify(result, null, 2))
    return result;
  }

  /**
   * Given the amount of `baseToken` to put into a transaction, calculate the
   * amount of `quoteToken` that can be expected from the transaction.
   *
   * This is typically used for calculating token sell prices.
   *
   * @param baseToken Token input for the transaction
   * @param quoteToken Output from the transaction
   * @param amount Amount of `baseToken` to put into the transaction
   * @param allowedSlippage (Optional) Fraction in string representing the allowed slippage for this transaction
   */
  async estimateSellTrade(
    baseToken: Token,
    quoteToken: Token,
    amount: BigNumber,
    allowedSlippage?: string,
    poolId?: string,
  ) {
    logger.info(
      `Fetching pair data for ${quoteToken.address}-${baseToken.address}. SELL`,
    );

    this.inToken = `0x${quoteToken.address.slice(2)}`;
    this.outToken = `0x${baseToken.address.slice(2)}`;
    const swapKind = SwapKind.GivenIn

    if (poolId) {
      await this.balancer.pools.fetchPoolState(poolId);
    } else {
      console.log('poolId is required to fetch pool state');
    }

    const token$1 = new Token$1(
      this._chain.chainId,
      this.inToken,
      baseToken.decimals,
    );

    const swapAmount = TokenAmount.fromRawAmount(
      token$1,
      `${amount.toString()}`,
    );

    const infoParams = {
      chainId: this._chain.chainId,
      tokenIn: this.inToken,
      tokenOut: this.outToken,
      swapKind: swapKind,
      swapAmount: swapAmount,
    };

    const info = await this.balancer.sorSwapPaths.fetchSorSwapPaths(infoParams);

    if (info.length === 0) {
      throw new UniswapishPriceError(
        `No pool found for ${quoteToken.address} to ${baseToken.address}.`,
      );
    }

    const bestPath = info[0];
    const outputAmount = bestPath.outputAmountRaw;
    const inputAmount = bestPath.inputAmountRaw;

    const marketSp = math.divide(
      math.fraction(outputAmount.toString()),
      math.fraction(inputAmount.toString()),
    ) as math.Fraction;

    const executionPrice = new Fraction(
      marketSp.d.toString(),
      marketSp.n.toString(),
    );

    const tokenAddresses = info[0].tokens.map(
      (token: { address: Address }) => token.address,
    );

    const swaps: SwapV2[] = info[0].pools.map(
      (pool: string, index: number) => ({
        poolId: pool as string,
        assetInIndex: index,
        assetOutIndex: index + 1 < tokenAddresses.length ? index + 1 : index,
        amount: info[0].inputAmountRaw.toString(),
        userData: '0x',
        returnAmount: info[0].outputAmountRaw.toString(),
      }),
    );

    const swapInfo: SwapInfo = {
      tokenAddresses: tokenAddresses,
      swaps: swaps,
      swapAmount: BigNumber.from(inputAmount),
      swapAmountForSwaps: BigNumber.from(inputAmount),
      returnAmount: BigNumber.from(outputAmount),
      returnAmountFromSwaps: BigNumber.from(outputAmount),
      returnAmountConsideringFees: BigNumber.from(outputAmount),
      tokenIn: tokenAddresses[0],
      tokenInForSwaps: tokenAddresses[0],
      tokenOut: tokenAddresses[tokenAddresses.length - 1],
      tokenOutFromSwaps: tokenAddresses[tokenAddresses.length - 1],
      marketSp: marketSp.toString(),
    };

    const result = {
      trade: {
        swap: {
          swapInfo: swapInfo,
          paths: info,
          maxSlippage: this.getAllowedSlippage(allowedSlippage),
          deadline: '0',
          kind: SwapKind.GivenIn,
        },
        executionPrice,
      },
      expectedAmount: CurrencyAmount.fromRawAmount(
        <Currency>quoteToken,
        outputAmount.toString(),
      ),
    };

    console.log(JSON.stringify(result, null, 2))
    return result;
  }

  /**
   * Given a wallet and a Uniswap trade, try to execute it on blockchain.
   *
   * @param wallet Wallet
   * @param trade Expected trade
   * @param gasPrice Base gas price, for pre-EIP1559 transactions
   * @param _router Router smart contract address
   * @param _ttl How long the swap is valid before expiry, in seconds
   * @param _abi Router contract ABI
   * @param gasLimit Gas limit
   * @param nonce (Optional) EVM transaction nonce
   * @param maxFeePerGas (Optional) Maximum total fee per gas you want to pay
   * @param maxPriorityFeePerGas (Optional) Maximum tip per gas you want to pay
   * @param allowedSlippage (Optional) Fraction in string representing the allowed slippage for this transaction
   */
  async executeTrade(
    wallet: Wallet,
    trade: UniswapishTrade,
    _gasPrice: number,
    _uniswapRouter: string,
    ttl: number,
    _abi: ContractInterface,
    gasLimit: number,
    nonce?: number,
    maxFeePerGas?: BigNumber,
    maxPriorityFeePerGas?: BigNumber,
  ): Promise<Transaction> {
    logger.info(`Inside executeTrade`);

    let overrideParams: OverrideParams;

    if (maxFeePerGas || maxPriorityFeePerGas) {
      overrideParams = {
        gasLimit: gasLimit,
        value: 0,
        nonce: nonce,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };
    } else {
      overrideParams = {
        gasLimit: gasLimit.toFixed(0),
        value: 0,
        nonce: nonce,
      };
    }

    const t: BalancerTrade = <BalancerTrade>trade;

    const swapInput: SwapInput = {
      chainId: this._chain.chainId,
      paths: t.swap.paths,
      swapKind: t.swap.kind,
    };

    const swap = new Swap(swapInput);
    const queryOutput = await swap.query(this.ganacheRpcUrl);

    console.log(ttl)
    
    const deadline = BigInt(99999999999999);
    const slippage = Slippage.fromPercentage(`${this.getAllowedSlippage()}`);
    const buildCallParams: SwapBuildCallInput = {
      slippage: slippage,
      deadline: deadline,
      queryOutput: queryOutput,
      sender: `0x${wallet.address.slice(2)}`,
      recipient: `0x${wallet.address.slice(2)}`,
    };

    const swapCall = swap.buildCall(buildCallParams);

    const tx = {
      to: swapCall.to,
      data: swapCall.callData,
      value: swapCall.value,
    };

    const txResponse: ContractTransaction = await EVMTxBroadcaster.getInstance(
      this._chain,
      wallet.address,
    ).broadcast({ ...tx, ...overrideParams });

    logger.info(`Transaction Details: ${JSON.stringify(txResponse)}`);
    return txResponse;
  }
}
