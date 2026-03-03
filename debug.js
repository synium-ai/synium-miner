import { ethers } from 'ethers';

const PK = "0xfd44ca57bff8d8bb2ce369ba1503211f57da0593f678c9fce5101dd861d5f01d";
const CONTRACT = "0xc1D9dCa8e9bb2E78098468f93f705493acFE9210";
const RPC = "https://sepolia.drpc.org";

async function main() {
    const wallet = new ethers.Wallet(PK);
    console.log("Expected Verifier Address (from PK):", wallet.address);

    const provider = new ethers.JsonRpcProvider(RPC);
    const contract = new ethers.Contract(CONTRACT, ["function verifier() view returns (address)"], provider);
    
    try {
        const onChainVerifier = await contract.verifier();
        console.log("Actual On-Chain Verifier:       ", onChainVerifier);
        
        if (onChainVerifier === wallet.address) {
            console.log("✅ MATCH! Address is correct.");
        } else {
            console.log("❌ MISMATCH! Contract is using a different verifier.");
        }
    } catch (e) {
        console.log("Error reading contract:", e.message);
    }
}

main();
