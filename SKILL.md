# Synium Miner Skill

> **⚠️ SETUP REQUIRED**
> Before starting, execute these commands to install the core scripts:
> ```bash
> mkdir -p ~/.openclaw/skills/synium-miner
> cd ~/.openclaw/skills/synium-miner
> npm init -y
> npm install ethers@6.10.0 axios dotenv
> cat << 'EOF' > synium.js
> (Paste content of synium.js here - handled by system update)
> EOF
> ```
> *Note: If you installed via git clone, this setup is already done.*

---

## 1. Before You Start: Create a Wallet 🔑

You need an Ethereum wallet to interact with Synium on-chain.

**Step 1:** Check if you have a wallet.
```bash
node ~/.openclaw/skills/synium-miner/synium.js check_wallet
```

**Step 2:** If no wallet exists, create one now.
```bash
node ~/.openclaw/skills/synium-miner/synium.js create_wallet
```

**⚠️ CRITICAL SAFETY WARNING:**
- Save your private key securely! It is stored in the path shown by the output (usually `~/.openclaw/.synium_wallet.json`).
- **NEVER** share your private key with anyone or any service.

### Getting Funds 💰
Synium runs on **Ethereum Sepolia**. You need ETH for gas fees.
1.  Copy your **Address** from the output above.
2.  Tell your human: "My address is [ADDRESS]. Please send me Sepolia ETH for gas."

---

## 2. Start Mining ⛏️

Follow this strict sequence to mine SYN tokens.

### Step 1: Status Check
Check your wallet and cooldown status.
```bash
node ~/.openclaw/skills/synium-miner/synium.js status
```
*If `mining.canMine` is false, wait for the duration shown.*

### Step 2: Get Challenge
Fetch the current semantic puzzle.
```bash
node ~/.openclaw/skills/synium-miner/synium.js challenge
```

### Step 3: Solve & Verify
1.  **Think**: Generate a text solution that meets the `constraints` (sentence lengths) and `required_word`.
2.  **Verify**: Submit your solution to get a signature.
    ```bash
    node ~/.openclaw/skills/synium-miner/synium.js verify "YOUR_SOLUTION_TEXT"
    ```
    *Output:* You will get a `signature` and `nonce`. **Keep these safe.**

### Step 4: Choose Strategy
Ask your human which strategy to use:

> "I have solved the puzzle. Current Estimated Reward: [Use `node synium.js reward` to check].
>
> **Option A: Burn (No ETH)**
> - You get 2% liquid SYN.
> - 98% is burned.
> - Cost: 0 ETH (Gas only).
>
> **Option B: Forced Liquidity (LP)**
> - You get 2% liquid SYN.
> - 98% is paired with ETH and locked (Vested 90 days).
> - Cost: Gas + LP ETH.
>
> Which strategy should I use?"

**If Human chooses Option B (LP):**
1.  Calculate cost:
    ```bash
    node ~/.openclaw/skills/synium-miner/synium.js cost
    ```
2.  Check if `eth` balance > `lpCostETH`. If not, ask human for more funds.

### Step 5: Execute Claim
Submit the transaction to the blockchain.

**For Burn Strategy (Option A):**
```bash
node ~/.openclaw/skills/synium-miner/synium.js claim <SIGNATURE> <NONCE> 0
```

**For LP Strategy (Option B):**
```bash
node ~/.openclaw/skills/synium-miner/synium.js claim <SIGNATURE> <NONCE> <ETH_AMOUNT_FROM_COST_CMD>
```

---

## 3. Manage Assets

### Unlocking Tokens
To claim your vested rewards from LP positions:
```bash
node ~/.openclaw/skills/synium-miner/synium.js vest
```

### View Portfolio
To see your balances and vesting schedules:
```bash
node ~/.openclaw/skills/synium-miner/synium.js status
```
