import { ethers, AbiCoder, keccak256 } from 'ethers';

const RPC = "https://sepolia.drpc.org";
const HELPER = "0x6407CDAAe652Ac601Df5Fba20b0fDf072Edd2013";
const SYN = "0xc1D9dCa8e9bb2E78098468f93f705493acFE9210";
const WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14"; // Common Sepolia WETH
const ETH_ZERO = "0x0000000000000000000000000000000000000000";

const HELPER_ABI = [
    "function getPoolStateInfo(bytes32 poolId) view returns (tuple(uint128 totalSupply, uint32 lastUpdated, uint24 lpFee, uint24 marginFee, uint24 protocolFee, uint128 realReserve0, uint128 realReserve1, uint128 mirrorReserve0, uint128 mirrorReserve1, uint128 pairReserve0, uint128 pairReserve1))"
];

function getPoolId(tokenA, tokenB, fee, marginFee) {
    const abiCoder = AbiCoder.defaultAbiCoder();
    // Sort tokens? Usually required for PoolId but let's trust the input order for now or try both
    // Actually, Uniswap/Likwid logic: token0 < token1.
    let t0 = tokenA;
    let t1 = tokenB;
    if (t0.toLowerCase() > t1.toLowerCase()) {
        [t0, t1] = [t1, t0];
    }
    
    const encoded = abiCoder.encode(
        ["tuple(address currency0, address currency1, uint24 fee, uint24 marginFee)"],
        [[t0, t1, fee, marginFee]]
    );
    return keccak256(encoded);
}

async function checkPool(name, tokenA, tokenB) {
    const provider = new ethers.JsonRpcProvider(RPC);
    const contract = new ethers.Contract(HELPER, HELPER_ABI, provider);
    
    const poolId = getPoolId(tokenA, tokenB, 3000, 3000);
    console.log(`Checking ${name}...`);
    console.log(`  Token0: ${tokenA < tokenB ? tokenA : tokenB}`);
    console.log(`  Token1: ${tokenA < tokenB ? tokenB : tokenA}`);
    console.log(`  PoolID: ${poolId}`);
    
    try {
        const state = await contract.getPoolStateInfo(poolId);
        console.log(`  ✅ Reserves: ${state.pairReserve0} / ${state.pairReserve1}`);
    } catch (e) {
        console.log(`  ❌ Check failed: ${e.message}`);
    }
}

async function main() {
    await checkPool("Native ETH / SYN", ETH_ZERO, SYN);
    await checkPool("WETH / SYN", WETH, SYN);
}

main();
