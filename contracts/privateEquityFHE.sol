pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract PrivateEquityFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 totalEncryptedShares;
        uint256 totalEncryptedValue;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct EncryptedShare {
        euint32 encryptedShares;
        euint32 encryptedValuePerShare;
    }
    mapping(uint256 => mapping(address => EncryptedShare)) public batchShares;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PauseToggled(bool indexed paused);
    event CooldownSecondsUpdated(uint256 indexed oldCooldown, uint256 indexed newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId, uint256 totalEncryptedShares, uint256 totalEncryptedValue);
    event SharesSubmitted(address indexed provider, uint256 indexed batchId, euint32 encryptedShares, euint32 encryptedValuePerShare);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint256 totalShares, uint256 totalValue);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error DecryptionFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 60; 
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PauseToggled(_paused);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        emit CooldownSecondsUpdated(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batches[currentBatchId] = Batch(currentBatchId, true, 0, 0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 batchId) external onlyOwner whenNotPaused {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].isOpen) {
            revert InvalidBatch();
        }
        Batch storage batch = batches[batchId];
        batch.isOpen = false;
        emit BatchClosed(batchId, batch.totalEncryptedShares, batch.totalEncryptedValue);
    }

    function _initIfNeeded(euint32 value) internal {
        if (!value.isInitialized()) {
            value.asEuint32(0);
        }
    }

    function submitEncryptedShares(
        uint256 batchId,
        euint32 encryptedShares,
        euint32 encryptedValuePerShare
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (batchId == 0 || batchId > currentBatchId || !batches[batchId].isOpen) {
            revert InvalidBatch();
        }
        _initIfNeeded(encryptedShares);
        _initIfNeeded(encryptedValuePerShare);

        batchShares[batchId][msg.sender] = EncryptedShare(encryptedShares, encryptedValuePerShare);

        Batch storage batch = batches[batchId];
        batch.totalEncryptedShares = batch.totalEncryptedShares.add(encryptedShares);
        batch.totalEncryptedValue = batch.totalEncryptedValue.add(encryptedShares.mul(encryptedValuePerShare));

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit SharesSubmitted(msg.sender, batchId, encryptedShares, encryptedValuePerShare);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused checkDecryptionCooldown {
        if (batchId == 0 || batchId > currentBatchId || batches[batchId].isOpen) {
            revert InvalidBatch();
        }

        Batch storage batch = batches[batchId];
        euint32 memory totalSharesEnc = batch.totalEncryptedShares;
        euint32 memory totalValueEnc = batch.totalEncryptedValue;

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = totalSharesEnc.toBytes32();
        cts[1] = totalValueEnc.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext(batchId, stateHash, false);
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        uint256 batchId = decryptionContexts[requestId].batchId;
        if (batchId == 0 || batchId > currentBatchId) {
            revert InvalidBatch();
        }

        Batch storage batch = batches[batchId];
        euint32 memory totalSharesEnc = batch.totalEncryptedShares;
        euint32 memory totalValueEnc = batch.totalEncryptedValue;

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = totalSharesEnc.toBytes32();
        cts[1] = totalValueEnc.toBytes32();

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {} catch {
            revert DecryptionFailed();
        }

        uint256 totalSharesCleartext = abi.decode(cleartexts, (uint256));
        uint256 totalValueCleartext = abi.decode(cleartexts[32:], (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, totalSharesCleartext, totalValueCleartext);
    }
}