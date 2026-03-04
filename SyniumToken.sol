// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IPairPositionManager} from "@likwid-fi/core/interfaces/IPairPositionManager.sol";
import {PoolKey} from "@likwid-fi/core/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "@likwid-fi/core/types/Currency.sol";

contract SyniumToken is ERC20, Ownable, ReentrancyGuard, IERC721Receiver {
    using ECDSA for bytes32;

    // --- Custom Errors ---
    error InvalidVerifierAddress();
    error InvalidPositionManagerAddress();
    error InvalidEpochLength();
    error WaitCooldown();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error ETHRefundFailed();

    // --- Config ---
    address public verifier;
    address public likwidPositionManager;

    uint256 public constant MAX_SUPPLY = 21_000_000 ether;
    uint256 public constant DECAY_RATE = 99; // 99%
    uint256 public constant VESTING_DURATION = 98 days;
    uint256 public constant MIN_REWARD_THRESHOLD = 0.001 ether; // Minimum reward to continue mining
    uint24 public constant POOL_FEE = 3000; // 0.3%
    uint24 public constant POOL_MARGIN_FEE = 3000; // 0.3%

    // --- Dynamic Reward State ---
    uint256 public baseReward = 21_000 ether;
    uint256 public minedTotal = 0;
    uint256 public nextDecayThreshold = 21_000 ether;

    // --- Epoch State ---
    uint256 public epochLength = 7200; // ~24 hours
    uint256 public currentEpochEndBlock;
    uint256 public agentsInCurrentEpoch;
    uint256 public agentsInLastEpoch;

    // --- User State ---
    mapping(address => uint256) public lastClaimBlock;
    mapping(address => mapping(uint256 => bool)) public usedNonces; // Verifier Nonce Storage

    struct VestingSchedule {
        uint256 totalLocked;
        uint256 released;
        uint256 startTime;
        uint256 endTime;
        uint256 lpTokenId; // Likwid NFT ID
    }
    mapping(address => VestingSchedule) public vestingSchedules;

    // --- Events ---
    event Claimed(address indexed user, uint256 totalReward, bool lpAdded);
    event VestedClaimed(address indexed user, uint256 amount);
    event EpochRotated(uint256 oldAgents, uint256 blockNumber);
    event DecayTriggered(uint256 newBaseReward, uint256 newThreshold);
    event EpochLengthUpdated(uint256 oldValue, uint256 newValue);
    event VerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    constructor(address _verifier, address _likwidPm) ERC20("Synium", "SYN") Ownable(msg.sender) {
        if (_verifier == address(0)) revert InvalidVerifierAddress();
        if (_likwidPm == address(0)) revert InvalidPositionManagerAddress();
        verifier = _verifier;
        likwidPositionManager = _likwidPm;
        currentEpochEndBlock = block.number + epochLength;
        agentsInCurrentEpoch = 0;
        agentsInLastEpoch = 0; // 0 indicates Genesis Epoch

        // --- Genesis Liquidity Mint ---
        uint256 genesisSupply = baseReward;
        _mint(msg.sender, genesisSupply);
        minedTotal += genesisSupply;
        baseReward = (genesisSupply * DECAY_RATE) / 100;
        nextDecayThreshold += baseReward;
    }

    // --- Admin ---
    function setVerifier(address _newVerifier) external onlyOwner {
        if (_newVerifier == address(0)) revert InvalidVerifierAddress();
        address oldVerifier = verifier;
        verifier = _newVerifier;
        emit VerifierUpdated(oldVerifier, _newVerifier);
    }

    function setEpochLength(uint256 _newEpochLength) external onlyOwner {
        if (_newEpochLength == 0) revert InvalidEpochLength();
        uint256 oldValue = epochLength;
        epochLength = _newEpochLength;
        emit EpochLengthUpdated(oldValue, _newEpochLength);
    }

    // --- View Functions ---

    function getEstimatedReward() public view returns (uint256) {
        uint256 currentAgents = agentsInCurrentEpoch + 1; // Simulate next claim
        uint256 lastAgents = agentsInLastEpoch;

        if (lastAgents == 0) {
            return baseReward / currentAgents;
        } else {
            uint256 numerator = baseReward * lastAgents;
            uint256 denominator = currentAgents + (lastAgents * lastAgents);
            return numerator / denominator;
        }
    }

    function timeUntilNextClaim(address user) public view returns (uint256) {
        if (block.number >= currentEpochEndBlock) {
            return 0;
        }
        uint256 epochStartBlock = currentEpochEndBlock - epochLength;
        if (lastClaimBlock[user] >= epochStartBlock) {
            return currentEpochEndBlock - block.number;
        }
        return 0;
    }

    // --- Core Mining ---
    function claim(
        bytes calldata signature,
        uint256 nonce // Verifier-provided Nonce (Timestamp)
    )
        external
        payable
        nonReentrant
    {
        // 1. Frequency Check
        if (block.number < lastClaimBlock[msg.sender] + epochLength) revert WaitCooldown();
        lastClaimBlock[msg.sender] = block.number;

        // 2. Replay Check (Using Verifier Nonce)
        if (usedNonces[msg.sender][nonce]) revert NonceAlreadyUsed();
        usedNonces[msg.sender][nonce] = true;

        // 3. Epoch Rotation Check
        if (block.number > currentEpochEndBlock) {
            agentsInLastEpoch = agentsInCurrentEpoch > 0 ? agentsInCurrentEpoch : 1; // Avoid 0
            agentsInCurrentEpoch = 0;
            currentEpochEndBlock = block.number + epochLength;
            emit EpochRotated(agentsInLastEpoch, block.number);
        }

        // 4. Verify Signature

        bytes32 hash = _getHash(msg.sender, nonce);
        bytes32 ethSignedMessageHash = MessageHashUtils.toEthSignedMessageHash(hash);
        address signer = ECDSA.recover(ethSignedMessageHash, signature);
        if (signer != verifier) revert InvalidSignature();

        // 5. Calculate Reward
        agentsInCurrentEpoch++;
        uint256 reward = _calculateRewardInternal();

        // 6. Update Decay
        minedTotal += reward;
        if (minedTotal >= nextDecayThreshold) {
            baseReward = (baseReward * DECAY_RATE) / 100;
            nextDecayThreshold += baseReward;
            emit DecayTriggered(baseReward, nextDecayThreshold);
        }

        // 7. Distribution Logic
        uint256 liquidPart = (reward * 2) / 100;
        uint256 vestedPart = reward - liquidPart;

        if (msg.value > 0) {
            // --- Option A: Provide LP ---
            _handleLiquidityProvision(liquidPart, vestedPart);
        } else {
            // --- Option B: Burn Vesting ---
            _mint(msg.sender, liquidPart);
            // vestedPart is effectively burned (never minted)
            emit Claimed(msg.sender, reward, false);
        }
    }

    function claimVested() external nonReentrant {
        _internalClaimVested(msg.sender);

        VestingSchedule storage schedule = vestingSchedules[msg.sender];
        if (schedule.released >= schedule.totalLocked && schedule.totalLocked > 0) {
            if (schedule.lpTokenId != 0) {
                IPairPositionManager(likwidPositionManager)
                    .safeTransferFrom(address(this), msg.sender, schedule.lpTokenId);
                schedule.lpTokenId = 0;
                schedule.totalLocked = 0;
                schedule.released = 0;
            }
        }
    }

    // Hash: keccak256(msg.sender, nonce)
    function _getHash(address signer, uint256 nonce) internal pure returns (bytes32 hash) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, shl(96, signer))
            mstore(add(ptr, 20), nonce)
            hash := keccak256(ptr, 52)
        }
    }

    function _calculateRewardInternal() internal view returns (uint256) {
        if (agentsInLastEpoch == 0) {
            return baseReward / agentsInCurrentEpoch;
        } else {
            uint256 numerator = baseReward * agentsInLastEpoch;
            uint256 denominator = agentsInCurrentEpoch + (agentsInLastEpoch * agentsInLastEpoch);
            uint256 reward = numerator / denominator;

            if (totalSupply() + reward > MAX_SUPPLY) {
                uint256 remaining = MAX_SUPPLY - totalSupply();
                return remaining >= MIN_REWARD_THRESHOLD ? remaining : 0;
            }
            return reward;
        }
    }

    function _handleLiquidityProvision(uint256 liquidSyn, uint256 vestedSyn) internal {
        _mint(address(this), liquidSyn);
        _approve(address(this), likwidPositionManager, liquidSyn);

        // Params for Likwid
        uint256 amount0 = msg.value; // ETH
        uint256 amount1 = liquidSyn; // SYN

        VestingSchedule storage schedule = vestingSchedules[msg.sender];
        uint256 tokenId = schedule.lpTokenId;

        if (tokenId == 0) {
            PoolKey memory poolKey = PoolKey({
                currency0: CurrencyLibrary.ADDRESS_ZERO,
                currency1: Currency.wrap(address(this)),
                fee: POOL_FEE,
                marginFee: POOL_MARGIN_FEE
            });
            // Add Liquidity
            (uint256 newTokenId,) = IPairPositionManager(likwidPositionManager).addLiquidity{value: msg.value}(
                poolKey, address(this), amount0, amount1, 0, liquidSyn, block.timestamp
            );
            schedule.lpTokenId = newTokenId;
        } else {
            // Increase Liquidity
            IPairPositionManager(likwidPositionManager).increaseLiquidity{value: msg.value}(
                tokenId, amount0, amount1, 0, liquidSyn, block.timestamp
            );
        }

        // Setup Vesting
        _setupVesting(msg.sender, vestedSyn);

        // Refund Excess ETH
        uint256 ethRefund = address(this).balance;
        if (ethRefund > 0) {
            (bool success,) = msg.sender.call{value: ethRefund}("");
            if (!success) revert ETHRefundFailed();
        }
        emit Claimed(msg.sender, liquidSyn + vestedSyn, true);
    }

    function _setupVesting(address user, uint256 amount) internal {
        VestingSchedule storage schedule = vestingSchedules[user];

        if (schedule.totalLocked > 0) {
            _internalClaimVested(user);
        }

        schedule.startTime = block.timestamp;
        schedule.endTime = block.timestamp + VESTING_DURATION;
        schedule.totalLocked += amount;
    }

    function _internalClaimVested(address user) internal {
        VestingSchedule storage schedule = vestingSchedules[user];
        if (block.timestamp < schedule.startTime) return;

        uint256 timeElapsed = block.timestamp - schedule.startTime;
        uint256 duration = schedule.endTime - schedule.startTime;

        if (timeElapsed >= duration) {
            uint256 payout = schedule.totalLocked - schedule.released;
            if (payout > 0) {
                schedule.released += payout;
                _mint(user, payout);
            }
        } else {
            uint256 vested = (schedule.totalLocked * timeElapsed) / duration;
            uint256 payout = vested - schedule.released;
            if (payout > 0) {
                schedule.released += payout;
                _mint(user, payout);
            }
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}
