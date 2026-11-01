import type { Address } from "viem";

/** Contract addresses as each launchpad's own site configures them (read from their front-end bundles). */

export const KLEOS = {
  /** KleosSwap (FluxSwap, Uniswap v3 fork) launchpad: the first Kleos generation. */
  launchpad: "0x6E3AFDdc49f5D43858a1FDD48184426deD11029b" as Address,
  legacyLaunchpads: ["0x7700Cb672BbD853CF57e82Ea14C3ebBaAc3ec470"] as Address[],
  swapRouter: "0x03c291D55Cc178B8Fc3e20607125b8F6e9D12687" as Address,
  quoterV2: "0x18C139815b72f06a89e5e7f811427CD96b61Caff" as Address,
  whype: "0x0269031ace34a7821e9D9980d087c35cE7c19EEF" as Address,
  /** Kleos v4: HYPE-paired launches, traded through the Kleos v4 router. */
  v4: {
    launcher: "0x893217cBF5c054FD6EE56893B313a4b98C4403E4" as Address,
    hook: "0x0c835e6A51717a514144d95c7F0a1C640179E0Cc" as Address,
    router: "0xbA0b2699A9d21a2a138C494db82DFD2fFce3344c" as Address,
  },
  /** KLEOS-paired launches: the router takes HYPE and hops through KLEOS itself. */
  pairs: [
    {
      launcher: "0x3AD2Ea50c1BFfBDE6FA47E219D2e1e838B22Cb77" as Address,
      hook: "0x772AccB053609D361593345e361D2a6854Ede8cc" as Address,
      router: "0x819741D02baFa76f0eEDF9EE8eDAb2a3EcCD37de" as Address,
      quote: "0x51C343Ed5131F17895991849860B61C2cb0E7e7a" as Address,
      symbol: "KLEOS",
    },
  ],
} as const;

export const ELYSP = {
  /** Launchpad v1: Uniswap v3 style pools behind the ElysPump SwapRouter (deadline in the struct). */
  v1: {
    router: "0x10c2b8f290f90f373b9b86c14cdf532367d1a22e" as Address,
    weth: "0xba876237b0f021a6c6d852d6c26e107997cc5e81" as Address,
    factory: "0x367f85886af509e364c8190862bc714555fefc3e" as Address,
    quoter: "0x3e6158ef8ee2087b210a59939a1fff6d20c3dd7e" as Address,
    fee: 10000,
  },
  /** Launchpad v2: Uniswap v4 pools with the ElysPump hook, traded through the Universal Router; sells use Permit2. */
  v2: {
    hook: "0xe11cafa5901b0aab51eb78251488400f9e4320cc" as Address,
    poolManager: "0x5fb015a49f5b35073f9ce01c2adb287a75f89600" as Address,
    stateView: "0xe83b98c30198319277c03d31f107277f40e96d70" as Address,
    quoter: "0x4861741785a8319a935741d0b570cafc33c4ca6b" as Address,
    router: "0x751cefb96ac88db5327d39e0fbdd5d882d80b430" as Address,
    permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3" as Address,
    tickSpacing: 200,
    lpFee: 0,
  },
} as const;

export const STOCKIUM = {
  /** HyperEVM side: bonding curves until graduation. */
  launchpad: "0x49Da2129cb75186254448A214f597Ec53262252d" as Address,
  /** Orbit gateway router on HyperEVM: maps a HyperEVM token to its bridged Elysium address. */
  gatewayRouter: "0x5D24f760DD7664b4214bDD4B04a3f62B9edd68c0" as Address,
  /** Elysium side: StockiumSwap (Uniswap v3 fork) after graduation. */
  swapFactory: "0x4F66184A9FFabB7f7071D590C2c48DEDf41676f4" as Address,
  swapRouter: "0xf7d8d5f9B9125b3d29c5778Df5E54c1bbe77f224" as Address,
  quoterV2: "0x1947918B6bf36112F7bA8AA983e8D94ce574163a" as Address,
  /** WETH9 of the StockiumSwap router (the same WHYPE ElysPump uses). */
  whype: "0xbA876237B0F021A6c6D852d6c26E107997cC5E81" as Address,
  /** Graduated curves register their Elysium pool here (poolOf(l1Token)). */
  receivers: [
    "0x641fc700Ff9069Ae22FFdf4da51dA10d69dc33a9",
    "0x954Ddaa05be5a809e65b90B719375F40Da0A2783",
    "0x28633444914FaFaBA480f07162E4F1E11dBD5B99",
    "0xE8051DD980E02364ca29F146622F8c01Fb2A6842",
    "0xAb22a17fC0185E70b25410384f9F586eA76F1562",
    "0x482DA548b26FBb5DE8CAD6421B08fa28791e22d2",
    "0x3ec96F4E0620F4E5A1d3C5D8C919B2DD1a666ae1",
  ] as Address[],
  /** Hub pairs: tokens paired with a hub are bought WHYPE -> hub -> token in one exactInput. */
  hubs: [{ pair: "0x1E0Cc793904F7D33fc632E97FE23B81a00a762a3" as Address, fee: 10000 as number }],
  fees: [100, 500, 3000, 10000, 20000] as number[],
} as const;
