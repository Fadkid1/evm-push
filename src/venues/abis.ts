import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Uniswap v3 SwapRouter (v1: deadline inside the struct), as forked by FluxSwap, ElysPump and StockiumSwap. */
export const swapRouterAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "struct ExactInputParams { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

export const quoterV2Abi = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

export const v3PoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

export const v3FactoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);

export const kleosLaunchpadAbi = parseAbi([
  "function getLaunch(address token) view returns ((address creator, uint64 createdAt, uint64 createdBlock, bool tokenIsToken0, uint16 creatorShareBps, uint16 buybackBps, uint64 windowEndsAt, address pool, uint256 positionId, int24 tickLower, int24 tickUpper, uint256 startMarketCap))",
  "function spotPrice(address token) view returns (uint256)",
]);

export const kleosLauncherAbi = parseAbi([
  "function getLaunch(address token) view returns ((address creator, uint64 createdAt, uint64 createdBlock, uint64 windowEndsAt, int24 tickLower, int24 tickUpper, uint128 liquidity, bytes32 poolId, uint256 startMarketCap))",
  "function spotPrice(address token) view returns (uint256)",
]);

/** Kleos v4 router and KLEOS-pair router: HYPE in, HYPE out. */
export const kleosRouterAbi = parseAbi([
  "function buy(address token, uint256 minOut, address recipient, uint256 deadline) payable returns (uint256 out)",
  "function sell(address token, uint256 amountIn, uint256 minOut, address recipient, uint256 deadline) returns (uint256 out)",
  "function quoteBuy(address token, uint256 hypeIn) view returns (uint256)",
  "function quoteSell(address token, uint256 amountIn) view returns (uint256)",
]);

export const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function quoteExactInputSingle((PoolKey poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);

export const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

export const permit2Abi = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
]);

/** Stockium bonding curve on HyperEVM (the site uses this ABI for every curve). */
export const stockiumCurveAbi = parseAbi([
  "function token() view returns (address)",
  "function nativePair() view returns (bool)",
  "function state() view returns (uint256 virtualQuote_, uint256 virtualToken_, uint256 realQuote_, uint256 realToken_, uint256 graduationThreshold_, uint256 spotQuotePerToken, bool graduated_, bool ready_, bool retired_, address pool_)",
  "function quoteBuy(uint256 hypeIn) view returns (uint256 tokensOut, uint256 fee)",
  "function quoteSell(uint256 tokensIn) view returns (uint256 hypeOut, uint256 fee)",
  "function buy(uint256 minTokensOut, uint256 minPairOut) payable returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minHypeOut) returns (uint256 hypeOut)",
]);

export const stockiumReceiverAbi = parseAbi(["function poolOf(address l1Token) view returns (address)"]);

export const gatewayRouterAbi = parseAbi(["function calculateL2TokenAddress(address l1ERC20) view returns (address)"]);

export const inboxAbi = parseAbi([
  "function depositEth() payable returns (uint256)",
  "function sendL2Message(bytes messageData) returns (uint256)",
]);
