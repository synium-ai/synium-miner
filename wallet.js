import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';

// Constants
// Use HOME from env, fallback to current dir if not set (for safety)
const HOME = process.env.HOME || '.';
const WALLET_DIR = path.join(HOME, '.openclaw');
const WALLET_FILE = path.join(WALLET_DIR, '.synium_wallet.json');

/**
 * Ensures the wallet file exists and returns an ethers.Wallet connected to the provider.
 * If no wallet exists, it creates one and saves it securely.
 */
export async function getWallet(provider) {
    // 1. Ensure directory exists
    if (!fs.existsSync(WALLET_DIR)) {
        fs.mkdirSync(WALLET_DIR, { recursive: true });
    }

    if (fs.existsSync(WALLET_FILE)) {
        // 2. Load existing wallet
        try {
            const json = fs.readFileSync(WALLET_FILE, 'utf8');
            const data = JSON.parse(json);
            
            if (!data.privateKey) throw new Error("Wallet file corrupted: no privateKey");
            
            const wallet = new ethers.Wallet(data.privateKey, provider);
            return wallet;
        } catch (err) {
            console.error("Failed to load wallet:", err.message);
            throw err; // Re-throw to prevent generating a new wallet accidentally
        }
    } else {
        // 3. Create NEW wallet
        console.log("Creating new Synium Identity (Wallet)...");
        const wallet = ethers.Wallet.createRandom();
        
        const data = {
            address: wallet.address,
            privateKey: wallet.privateKey,
            mnemonic: wallet.mnemonic.phrase,
            createdAt: new Date().toISOString()
        };
        
        // Save securely (chmod 600 - user only)
        fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
        console.log(`Wallet saved to ${WALLET_FILE}`);
        
        return wallet.connect(provider);
    }
}
