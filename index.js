import { ethers, AbiCoder, keccak256 } from 'ethers';
import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Import Wallet Logic
import { getWallet } from './wallet.js';

// --- Config Setup ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '.env');
dotenv.config({ path: envPath });

// Constants
const VERIFIER_URL = "http://136.111.82.79";
const SYN_CONTRACT = "0xc1D9dCa8e9bb2E78098468f93f705493acFE9210";
const LIKWID_HELPER = "0x6407CDAAe652Ac601Df5Fba20b0fDf072Edd2013";
const RPC_URL = "https://sepolia.drpc.org";

// ABIs
const SYN_ABI = [
    "function getEstimatedReward() view returns (uint256)",
    "function claim(bytes signature, uint256 nonce, tuple(address currency0, address currency1, uint24 fee, uint24 marginFee) poolKey, uint256 amountEthMin, uint256 amountSynMin) external payable",
    "function claimVested() external",
    "function vestingSchedules(address) view returns (uint256 totalLocked, uint256 released, uint256 startTime, uint256 endTime, uint256 lpTokenId)",
    "function balanceOf(address) view returns (uint256)"
];
const HELPER_ABI = [
    "function getPoolStateInfo(bytes32 poolId) view returns (tuple(uint128 pairReserve0, uint128 pairReserve1))"
];

// --- Tool 1: Check Status & Get Challenge ---
export async function synium_status() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = await getWallet(provider);
    
    const ethBalance = await provider.getBalance(wallet.address);
    const synContract = new ethers.Contract(SYN_CONTRACT, SYN_ABI, wallet);
    let synBalance = 0n;
    let vesting = {};

    try {
        synBalance = await synContract.balanceOf(wallet.address);
        try {
             const v = await synContract.vestingSchedules(wallet.address);
             vesting = {
                totalLocked: ethers.formatEther(v.totalLocked),
                released: ethers.formatEther(v.released),
                endTime: new Date(Number(v.endTime) * 1000).toISOString(),
                lpTokenId: v.lpTokenId.toString()
            };
        } catch (e) {
             vesting = { status: "No active vesting" };
        }
    } catch (e) {
        vesting = { error: "Contract read failed: " + e.message };
    }
    
    // Get Challenge
    let challenge = null;
    try {
        const res = await axios.get(`${VERIFIER_URL}/challenge?address=${wallet.address}`);
        challenge = res.data;
    } catch (e) {
        challenge = { error: "Verifier unreachable" };
    }

    return JSON.stringify({
        address: wallet.address,
        ethBalance: ethers.formatEther(ethBalance),
        synBalance: ethers.formatEther(synBalance),
        vesting,
        challenge
    }, null, 2);
}

// --- Tool 2: Submit Mining Solution ---
export async function synium_mine({ answer }) {
    if (!answer) return JSON.stringify({ error: "Missing answer" });

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = await getWallet(provider);
    const synContract = new ethers.Contract(SYN_CONTRACT, SYN_ABI, wallet);

    console.log(`Mine: Submitting answer for ${wallet.address}...`);

    // 1. Verify Off-chain
    let signature;
    let nonce;
    try {
        const res = await axios.post(`${VERIFIER_URL}/verify`, {
            wallet_address: wallet.address,
            answer_text: answer
        });
        if (!res.data.success) return JSON.stringify({ success: false, error: "Verification Failed" });
        signature = res.data.signature;
        // Fix: Ensure 0x prefix for ethers.js compatibility
        if (!signature.startsWith('0x')) {
            signature = '0x' + signature;
        }
        nonce = res.data.nonce;
    } catch (e) {
        return JSON.stringify({ success: false, error: e.response?.data?.detail || e.message });
    }

    // 2. Calculate LP
    const poolKey = {
        currency0: "0x0000000000000000000000000000000000000000",
        currency1: SYN_CONTRACT,
        fee: 3000, marginFee: 3000
    };
    
    // PoolId Calc
    const abiCoder = AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
        ["tuple(address currency0, address currency1, uint24 fee, uint24 marginFee)"],
        [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.marginFee]]
    );
    const poolId = keccak256(encoded);

    // 3. Estimate & Check Balance
    const estReward = await synContract.getEstimatedReward();
    // Use 2%
    const liquidPart = estReward * 200n / 10000n; 

    // Helper Call
    const helper = new ethers.Contract(LIKWID_HELPER, HELPER_ABI, provider);
    let msgValue = 0n;
    let strategy = "Burn (No ETH)";
    let minEth = 0n;
    let minSyn = 0n;
    
    try {
        const state = await helper.getPoolStateInfo(poolId);
        if (state.pairReserve1 > 0n) {
            msgValue = liquidPart * BigInt(state.pairReserve0) / BigInt(state.pairReserve1);
            
            const bal = await provider.getBalance(wallet.address);
            if (bal >= msgValue + ethers.parseEther("0.005")) { // Gas buffer
                strategy = "Forced Liquidity (LP)";
                 // Slippage 0.5%
                 minEth = msgValue * 995n / 1000n;
                 minSyn = liquidPart * 995n / 1000n;
            } else {
                msgValue = 0n; // Not enough
            }
        }
    } catch (e) {
        console.log("Helper error (pool likely empty/new):", e.message);
    }

    // 4. Send TX
    try {
        // Claim Mine
        // Slippage 0.5%
        if (msgValue > 0n) {
             minEth = msgValue * 995n / 1000n;
             minSyn = liquidPart * 995n / 1000n;
        }

        const tx = await synContract.claim(
            signature, nonce, poolKey, minEth, minSyn, 
            { value: msgValue }
        );
        const receipt = await tx.wait();
        
        // Claim Vested (Best effort)
        try { await (await synContract.claimVested()).wait(); } catch(e) {}

        return JSON.stringify({
            success: true,
            hash: receipt.hash,
            strategy,
            reward: ethers.formatEther(estReward),
            cost: ethers.formatEther(msgValue)
        }, null, 2);
    } catch (e) {
        return JSON.stringify({ success: false, error: e.message });
    }
}

// CLI Support
const args = process.argv.slice(2);
if (args[0] === 'status') {
    synium_status().then(console.log);
} else if (args[0] === 'mine') {
    synium_mine({ answer: args[1] }).then(console.log);
}
