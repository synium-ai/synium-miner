import { ethers, keccak256, AbiCoder } from 'ethers';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// --- Configuration ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '.env');
dotenv.config({ path: envPath });

const CONFIG = {
    VERIFIER: "http://136.111.82.79",
    CONTRACT: "0xFC62570B59861F8E0DE767956FA521F8403F8b1c",
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
        "function claimVested() external",
        "function vestingSchedules(address) view returns (uint256 totalLocked, uint256 released, uint256 startTime, uint256 endTime, uint256 lpTokenId)",
        "function balanceOf(address) view returns (uint256)",
        "function timeUntilNextClaim(address user) view returns (uint256)",
        "function getClaimableVested(address user) view returns (uint256)"
    ],
    HELPER: [
        "function getPoolStateInfo(bytes32 poolId) view returns (tuple(uint128 totalSupply, uint32 lastUpdated, uint24 lpFee, uint24 marginFee, uint24 protocolFee, uint128 realReserve0, uint128 realReserve1, uint128 mirrorReserve0, uint128 mirrorReserve1, uint128 pairReserve0, uint128 pairReserve1, uint128 truncatedReserve0, uint128 truncatedReserve1, uint128 lendReserve0, uint128 lendReserve1, uint128 interestReserve0, uint128 interestReserve1, int128 insuranceFund0, int128 insuranceFund1, uint256 borrow0CumulativeLast, uint256 borrow1CumulativeLast, uint256 deposit0CumulativeLast, uint256 deposit1CumulativeLast))"
    ]
};

// --- Helper: Get Provider ---
function getProvider() {
    return new ethers.JsonRpcProvider(CONFIG.RPC);
}

// --- Helper: Get Wallet Instance (Read-only check) ---
function getWalletInstance(provider) {
    if (fs.existsSync(WALLET_FILE)) {
        try {
            const json = fs.readFileSync(WALLET_FILE, 'utf8');
            return new ethers.Wallet(JSON.parse(json).privateKey, provider);
        } catch (e) { return null; }
    }
    return null;
}

// ==========================================
// 1. Check Wallet Existence
// ==========================================
async function check_wallet() {
    const provider = getProvider();
    const wallet = getWalletInstance(provider);
    
    if (wallet) {
        const bal = await provider.getBalance(wallet.address);
        console.log(JSON.stringify({
            exists: true,
            address: wallet.address,
            balance: ethers.formatEther(bal) + " ETH",
            path: WALLET_FILE
        }, null, 2));
    } else {
        console.log(JSON.stringify({
            exists: false,
            message: "No wallet found. Use 'create_wallet' to generate one."
        }, null, 2));
    }
}

// ==========================================
// 2. Create Wallet
// ==========================================
async function create_wallet() {
    const provider = getProvider();
    let wallet = getWalletInstance(provider);

    if (wallet) {
        const bal = await provider.getBalance(wallet.address);
        console.log(JSON.stringify({
            status: "skipped",
            message: "Wallet already exists. Will not overwrite.",
            address: wallet.address,
            balance: ethers.formatEther(bal) + " ETH"
        }, null, 2));
    } else {
        // Ensure dir
        const dir = path.dirname(WALLET_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const newWallet = ethers.Wallet.createRandom();
        const data = { 
            address: newWallet.address, 
            privateKey: newWallet.privateKey, 
            mnemonic: newWallet.mnemonic.phrase 
        };
        fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
        
        console.log(JSON.stringify({
            status: "created",
            address: newWallet.address,
            balance: "0.0 ETH",
            path: WALLET_FILE
        }, null, 2));
    }
}

// ==========================================
// 3. Get Challenge
// ==========================================
async function get_challenge() {
    const provider = getProvider();
    const wallet = getWalletInstance(provider);
    if (!wallet) return console.log(JSON.stringify({ error: "No wallet found" }));

    try {
        const res = await axios.get(`${CONFIG.VERIFIER}/challenge?address=${wallet.address}`);
        console.log(JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.log(JSON.stringify({ error: "Verifier unreachable" }));
    }
}

// ==========================================
// 4. Verify Solution
// ==========================================
async function verify_solution(answer) {
    if (!answer) return console.log(JSON.stringify({ error: "Missing answer" }));
    
    const provider = getProvider();
    const wallet = getWalletInstance(provider);
    if (!wallet) return console.log(JSON.stringify({ error: "No wallet found" }));

    try {
        const res = await axios.post(`${CONFIG.VERIFIER}/verify`, { 
            wallet_address: wallet.address, 
            answer_text: answer 
        });
        
        if (res.data.success) {
            let sig = res.data.signature;
            if (!sig.startsWith('0x')) sig = '0x' + sig;
            
            console.log(JSON.stringify({
                status: "success",
                signature: sig,
                nonce: res.data.nonce,
                note: "Save these values for the claim step!"
            }, null, 2));
        } else {
            console.log(JSON.stringify({ status: "failed", error: "Verification rejected" }));
        }
    } catch (e) {
        console.log(JSON.stringify({ status: "error", message: e.response?.data || e.message }));
    }
}

// ==========================================
// 5. Get Status (Detailed)
// ==========================================
async function get_status() {
    const provider = getProvider();
    const wallet = getWalletInstance(provider);
    if (!wallet) return console.log(JSON.stringify({ error: "No wallet found" }));

    const contract = new ethers.Contract(CONFIG.CONTRACT, ABIS.SYN, wallet);
    
    const ethBal = await provider.getBalance(wallet.address);
    let synBal = 0n;
    let cooldown = 0n;
    let vesting = null;

    try { synBal = await contract.balanceOf(wallet.address); } catch(e){}
    try { cooldown = await contract.timeUntilNextClaim(wallet.address); } catch(e){}
    try {
        const v = await contract.vestingSchedules(wallet.address);
        vesting = {
            totalLocked: ethers.formatEther(v.totalLocked),
            released: ethers.formatEther(v.released),
            endTime: new Date(Number(v.endTime) * 1000).toISOString()
        };
    } catch(e) {}

    let nextClaimTime = "Now";
    if (cooldown > 0n) {
        // 1 block ~= 12 seconds
        const secondsWait = Number(cooldown) * 12;
        const targetDate = new Date(Date.now() + secondsWait * 1000);
        nextClaimTime = targetDate.toISOString();
    }

    console.log(JSON.stringify({
        address: wallet.address,
        eth: ethers.formatEther(ethBal),
        syn: ethers.formatEther(synBal),
        mining: {
            canMine: cooldown === 0n,
            blocksToWait: cooldown.toString(),
            nextClaimTime: nextClaimTime
        },
        vesting: vesting
    }, null, 2));
}

// ==========================================
// 6. Submit Claim (Atomic Transaction)
// ==========================================
async function submit_claim(signature, nonce, ethAmount) {
    if (!signature || !nonce) return console.log(JSON.stringify({ error: "Missing signature or nonce" }));
    
    const provider = getProvider();
    const wallet = getWalletInstance(provider);
    if (!wallet) return console.log(JSON.stringify({ error: "No wallet found" }));
    
    const contract = new ethers.Contract(CONFIG.CONTRACT, ABIS.SYN, wallet);
    const msgValue = ethAmount ? ethers.parseEther(ethAmount) : 0n;

    console.log(`Submitting tx... Sig: ${signature.slice(0,10)}..., Nonce: ${nonce}, Val: ${ethAmount || 0}`);

    try {
        const tx = await contract.claim(signature, nonce, { value: msgValue });
        console.log(JSON.stringify({
            status: "submitted",
            hash: tx.hash,
            message: "Waiting for confirmation..."
        }, null, 2));
        
        await tx.wait();
        console.log(JSON.stringify({ status: "confirmed", hash: tx.hash }));
    } catch (e) {
        const reason = e.shortMessage || e.message;
        console.log(JSON.stringify({ status: "failed", error: reason }));
    }
}

// ==========================================
// 7. Calculate LP Cost
// ==========================================
async function calc_lp_cost() {
    const provider = getProvider();
    
    const contract = new ethers.Contract(CONFIG.CONTRACT, ABIS.SYN, provider);
    const helper = new ethers.Contract(CONFIG.LIKWID_HELPER, ABIS.HELPER, provider);

    try {
        // 1. Get Reward
        const estReward = await contract.getEstimatedReward();
        const liquidPart = estReward * 200n / 10000n; // 2%

        // 2. Get Reserves
        // Contract internally uses these standard fee/margin
        const poolKey = { currency0: "0x0000000000000000000000000000000000000000", currency1: CONFIG.CONTRACT, fee: 3000, marginFee: 3000 };
        const abiCoder = AbiCoder.defaultAbiCoder();
        const pid = keccak256(abiCoder.encode(["tuple(address currency0, address currency1, uint24 fee, uint24 marginFee)"], [[poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.marginFee]]));
        
        const state = await helper.getPoolStateInfo(pid);
        const r0 = BigInt(state.pairReserve0); // ETH
        const r1 = BigInt(state.pairReserve1); // SYN

        let ethCost = 0n;
        if (r1 > 0n) {
            ethCost = liquidPart * r0 / r1;
            // Sanity check
            if (ethCost > ethers.parseEther("10")) ethCost = 0n; // Error case
        }

        console.log(JSON.stringify({
            estimatedReward: ethers.formatEther(estReward),
            liquidPart: ethers.formatEther(liquidPart),
            poolReserves: { eth: ethers.formatEther(r0), syn: ethers.formatEther(r1) },
            lpCostETH: ethers.formatEther(ethCost)
        }, null, 2));

    } catch (e) {
        console.log(JSON.stringify({ error: "Failed to calc cost", details: e.message }));
    }
}

// ==========================================
// 9. Check Cooldown (Simple)
// ==========================================
async function check_cooldown() {
    const provider = getProvider();
    const wallet = getWalletInstance(provider);
    if (!wallet) return console.log(JSON.stringify({ error: "No wallet" }));
    
    const contract = new ethers.Contract(CONFIG.CONTRACT, ABIS.SYN, wallet);
    try {
        const blocks = await contract.timeUntilNextClaim(wallet.address);
        console.log(JSON.stringify({
            canMine: blocks === 0n,
            blocksRemaining: blocks.toString(),
            secondsRemaining: (Number(blocks) * 12).toString()
        }, null, 2));
    } catch(e) {
        console.log(JSON.stringify({ error: e.message }));
    }
}

// ==========================================
// 10. Get Estimated Reward (Simple)
// ==========================================
async function get_reward() {
    const provider = getProvider();
    const contract = new ethers.Contract(CONFIG.CONTRACT, ABIS.SYN, provider);
    try {
        const rw = await contract.getEstimatedReward();
        console.log(JSON.stringify({ reward: ethers.formatEther(rw) }));
    } catch(e) {
        console.log(JSON.stringify({ error: e.message }));
    }
}

// ==========================================
// 11. Claim Vested
// ==========================================
async function claim_vested() {
    const provider = getProvider();
    const wallet = getWalletInstance(provider);
    if (!wallet) return console.log(JSON.stringify({ error: "No wallet" }));
    
    const contract = new ethers.Contract(CONFIG.CONTRACT, ABIS.SYN, wallet);
    console.log("Claiming vested tokens...");
    
    try {
        const tx = await contract.claimVested();
        console.log(JSON.stringify({ status: "submitted", hash: tx.hash }));
        await tx.wait();
        console.log(JSON.stringify({ status: "confirmed" }));
    } catch(e) {
        console.log(JSON.stringify({ status: "failed", error: e.shortMessage || e.message }));
    }
}

// ==========================================
// 12. Check Claimable Vested (New Atomic Method)
// ==========================================
async function check_claimable() {
    const provider = getProvider();
    const wallet = getWalletInstance(provider);
    if (!wallet) return console.log(JSON.stringify({ error: "No wallet" }));
    
    const contract = new ethers.Contract(CONFIG.CONTRACT, ABIS.SYN, wallet);
    try {
        const claimable = await contract.getClaimableVested(wallet.address);
        console.log(JSON.stringify({ 
            address: wallet.address,
            claimableVested: ethers.formatEther(claimable) + " SYN"
        }, null, 2));
    } catch(e) {
        console.log(JSON.stringify({ error: e.message }));
    }
}

// --- CLI Router ---
const args = process.argv.slice(2);
const cmd = args[0];

switch(cmd) {
    case 'check_wallet': check_wallet(); break;
    case 'create_wallet': create_wallet(); break;
    case 'challenge': get_challenge(); break;
    case 'verify': verify_solution(args[1]); break; // args[1] is answer
    case 'status': get_status(); break;
    case 'cost': calc_lp_cost(); break;
    case 'cooldown': check_cooldown(); break;
    case 'reward': get_reward(); break;
    case 'vest': claim_vested(); break;
    case 'claimable': check_claimable(); break; // New command
    case 'claim': 
        // usage: node synium.js claim <sig> <nonce> [ethAmount]
        submit_claim(args[1], args[2], args[3]); 
        break;
    default:
        console.log("Commands: check_wallet, create_wallet, challenge, verify, status, cost, cooldown, reward, vest, claimable, claim");
}
