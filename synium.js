import { ethers, keccak256, AbiCoder } from 'ethers';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Configuration ---
const CONFIG = {
    VERIFIER: "http://136.111.82.79",
    CONTRACT: "0xc1D9dCa8e9bb2E78098468f93f705493acFE9210",
    LIKWID_HELPER: "0x6407CDAAe652Ac601Df5Fba20b0fDf072Edd2013",
    RPC: "https://ethereum-sepolia-rpc.publicnode.com", 
    HOME: process.env.HOME || '.'
};

const WALLET_FILE = path.join(CONFIG.HOME, '.openclaw', '.synium_wallet.json');

// --- ABIs ---
const ABIS = {
    SYN: [
        "function getEstimatedReward() view returns (uint256)",
        "function claim(bytes signature, uint256 nonce) external payable",
        "function vestingSchedules(address) view returns (uint256 totalLocked, uint256 released, uint256 startTime, uint256 endTime, uint256 lpTokenId)",
        "function balanceOf(address) view returns (uint256)",
        "function timeUntilNextClaim(address user) view returns (uint256)"
    ],
    HELPER: [
        "function getPoolStateInfo(bytes32 poolId) view returns (tuple(uint128 totalSupply, uint32 lastUpdated, uint24 lpFee, uint24 marginFee, uint24 protocolFee, uint128 realReserve0, uint128 realReserve1, uint128 mirrorReserve0, uint128 mirrorReserve1, uint128 pairReserve0, uint128 pairReserve1, uint128 truncatedReserve0, uint128 truncatedReserve1, uint128 lendReserve0, uint128 lendReserve1, uint128 interestReserve0, uint128 interestReserve1, int128 insuranceFund0, int128 insuranceFund1, uint256 borrow0CumulativeLast, uint256 borrow1CumulativeLast, uint256 deposit0CumulativeLast, uint256 deposit1CumulativeLast))"
    ]
};

// --- Wallet Management ---
async function getWallet(provider) {
    const dir = path.dirname(WALLET_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(WALLET_FILE)) {
        try {
            const json = fs.readFileSync(WALLET_FILE, 'utf8');
            return new ethers.Wallet(JSON.parse(json).privateKey, provider);
        } catch (e) { console.error("Wallet load error:", e.message); }
    }
    
    const wallet = ethers.Wallet.createRandom();
    const data = { address: wallet.address, privateKey: wallet.privateKey, mnemonic: wallet.mnemonic.phrase };
    fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
    return wallet.connect(provider);
}

// --- Command: Check Status ---
async function status() {
    const provider = new ethers.JsonRpcProvider(CONFIG.RPC);
    const wallet = await getWallet(provider);
    const contract = new ethers.Contract(CONFIG.CONTRACT, ABIS.SYN, wallet);
    
    console.log(`Checking status for: ${wallet.address}`);

    let bal = await provider.getBalance(wallet.address);
    let syn = 0n;
    let vest = "None";
    let cooldown = 0n;
    
    try { syn = await contract.balanceOf(wallet.address); } catch(e){}
    try { cooldown = await contract.timeUntilNextClaim(wallet.address); } catch(e){}
    try { 
        const v = await contract.vestingSchedules(wallet.address);
        if (v.totalLocked > 0n) {
            vest = { 
                locked: ethers.formatEther(v.totalLocked), 
                released: ethers.formatEther(v.released),
                endTime: new Date(Number(v.endTime) * 1000).toISOString()
            };
        }
    } catch(e) {}

    let challenge = "Offline";
    try {
        const res = await axios.get(`${CONFIG.VERIFIER}/challenge?address=${wallet.address}`);
        challenge = res.data;
    } catch(e){ console.log("Verifier Error:", e.message); }

    console.log(JSON.stringify({
        address: wallet.address,
        eth: ethers.formatEther(bal),
        syn: ethers.formatEther(syn),
        cooldownBlocks: cooldown.toString(),
        readyToMine: cooldown === 0n,
        vesting: vest,
        challenge: challenge
    }, null, 2));
}

// --- Command: Submit Solution ---
async function mine(answer) {
    if (!answer) return console.log("Error: Missing answer argument");
    
    const provider = new ethers.JsonRpcProvider(CONFIG.RPC);
    const wallet = await getWallet(provider);
    const contract = new ethers.Contract(CONFIG.CONTRACT, ABIS.SYN, wallet);

    // Check cooldown
    try {
        const cooldown = await contract.timeUntilNextClaim(wallet.address);
        if (cooldown > 0n) {
            return console.log(`⏳ Mining Cooldown Active. Wait ${cooldown} blocks.`);
        }
    } catch(e) {}

    console.log(`Mining initiated for ${wallet.address}...`);
    
    // 1. Verify Off-chain
    let sig, nonce;
    try {
        const res = await axios.post(`${CONFIG.VERIFIER}/verify`, { wallet_address: wallet.address, answer_text: answer });
        if(!res.data.success) throw new Error("Verification failed: " + JSON.stringify(res.data));
        
        sig = res.data.signature;
        if (!sig.startsWith('0x')) sig = '0x' + sig; 
        nonce = res.data.nonce;
        console.log("✅ Verification successful.");
    } catch(e) { return console.log("❌ Verify Error:", e.response?.data || e.message); }

    // 2. DeFi Logic: Calculate LP Requirement
    // Note: PoolKey construction is solely for PoolId calculation now. Contract has it built-in.
    const poolKey = { currency0: "0x0000000000000000000000000000000000000000", currency1: CONFIG.CONTRACT, fee: 3000, marginFee: 3000 };
    const abiCoder = AbiCoder.defaultAbiCoder();
    const pid = keccak256(abiCoder.encode(["tuple(address currency0, address currency1, uint24 fee, uint24 marginFee)"], [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.marginFee]]));
    
    const helper = new ethers.Contract(CONFIG.LIKWID_HELPER, ABIS.HELPER, provider);
    let msgValue = 0n, strategy = "Burn (Free)";

    try {
        console.log("🔍 Querying Liquidity Pool...");
        const est = await contract.getEstimatedReward();
        const liqPart = est * 200n / 10000n; // 2% Liquid
        
        const state = await helper.getPoolStateInfo(pid);
        const r0 = BigInt(state.pairReserve0);
        const r1 = BigInt(state.pairReserve1);
        
        console.log(`   Reserves: ${ethers.formatEther(r0)} ETH / ${ethers.formatEther(r1)} SYN`);

        if (r1 > 0n) {
            let ethNeeded = liqPart * r0 / r1;
            
            // Sanity Check
            if (ethNeeded > ethers.parseEther("10")) {
                console.log("⚠️ Anomaly: ETH cost too high. Ignoring LP.");
                ethNeeded = 0n;
            }

            const bal = await provider.getBalance(wallet.address);
            console.log(`   Cost: ${ethers.formatEther(ethNeeded)} ETH | Balance: ${ethers.formatEther(bal)} ETH`);

            if (ethNeeded > 0n && bal > ethNeeded + ethers.parseEther("0.005")) {
                strategy = "Forced Liquidity (LP + Vesting)";
                msgValue = ethNeeded;
            }
        }
    } catch(e) { console.log("⚠️ Helper Error (Pool might be empty):", e.message); }

    // 3. Submit Transaction
    try {
        console.log(`🚀 Submitting Claim... Strategy: ${strategy}`);
        // New: claim(signature, nonce) - No poolKey params!
        const tx = await contract.claim(sig, nonce, { value: msgValue });
        console.log(`✅ Tx Sent: ${tx.hash}`);
        await tx.wait();
        console.log("🎉 Mined Successfully!");
    } catch(e) { 
        const reason = e.shortMessage || e.message;
        console.log(`❌ Tx Failed: ${reason}`); 
    }
}

// CLI Router
const args = process.argv.slice(2);
if (args[0] === 'status') status();
else if (args[0] === 'mine') mine(args[1]);
else console.log("Usage: node synium.js [status|mine <answer>]");
