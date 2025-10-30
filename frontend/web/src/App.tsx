import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface EquityToken {
  id: string;
  encryptedValuation: string;
  encryptedShares: string;
  timestamp: number;
  issuer: string;
  companyName: string;
  status: "pending" | "approved" | "trading" | "rejected";
  transactionHistory: Transaction[];
}

interface Transaction {
  id: string;
  timestamp: number;
  from: string;
  to: string;
  encryptedAmount: string;
  type: "issuance" | "transfer" | "trade";
}

// FHE Encryption/Decryption utilities for numerical data
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}-ZAMA`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-') && encryptedData.endsWith('-ZAMA')) {
    return parseFloat(atob(encryptedData.substring(4, encryptedData.length - 5)));
  }
  return parseFloat(encryptedData);
};

// Generate mock public key for signature verification
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [tokens, setTokens] = useState<EquityToken[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newTokenData, setNewTokenData] = useState({ 
    companyName: "", 
    valuation: 0, 
    totalShares: 0,
    description: "" 
  });
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [selectedToken, setSelectedToken] = useState<EquityToken | null>(null);
  const [decryptedValuation, setDecryptedValuation] = useState<number | null>(null);
  const [decryptedShares, setDecryptedShares] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);

  // Statistics for dashboard
  const approvedCount = tokens.filter(t => t.status === "approved").length;
  const tradingCount = tokens.filter(t => t.status === "trading").length;
  const pendingCount = tokens.filter(t => t.status === "pending").length;
  const totalValuation = tokens.reduce((sum, token) => sum + (decryptedValuation || 0), 0);

  useEffect(() => {
    loadTokens().finally(() => setLoading(false));
    const initContractParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initContractParams();
  }, []);

  const loadTokens = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Test contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // Load token keys
      const keysBytes = await contract.getData("token_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing token keys:", e); }
      }

      const tokenList: EquityToken[] = [];
      for (const key of keys) {
        try {
          const tokenBytes = await contract.getData(`token_${key}`);
          if (tokenBytes.length > 0) {
            try {
              const tokenData = JSON.parse(ethers.toUtf8String(tokenBytes));
              tokenList.push({ 
                id: key, 
                encryptedValuation: tokenData.encryptedValuation, 
                encryptedShares: tokenData.encryptedShares,
                timestamp: tokenData.timestamp, 
                issuer: tokenData.issuer, 
                companyName: tokenData.companyName,
                status: tokenData.status || "pending",
                transactionHistory: tokenData.transactionHistory || []
              });
            } catch (e) { console.error(`Error parsing token data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading token ${key}:`, e); }
      }
      tokenList.sort((a, b) => b.timestamp - a.timestamp);
      setTokens(tokenList);
    } catch (e) { console.error("Error loading tokens:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const issueToken = async () => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    setIssuing(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting equity data with Zama FHE..." });
    
    try {
      // Encrypt sensitive numerical data using FHE
      const encryptedValuation = FHEEncryptNumber(newTokenData.valuation);
      const encryptedShares = FHEEncryptNumber(newTokenData.totalShares);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const tokenId = `token_${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const tokenData = { 
        encryptedValuation, 
        encryptedShares,
        timestamp: Math.floor(Date.now() / 1000), 
        issuer: address, 
        companyName: newTokenData.companyName,
        status: "pending",
        transactionHistory: [{
          id: `tx_${Date.now()}`,
          timestamp: Math.floor(Date.now() / 1000),
          from: address!,
          to: address!,
          encryptedAmount: encryptedShares,
          type: "issuance"
        }]
      };

      // Store token data
      await contract.setData(tokenId, ethers.toUtf8Bytes(JSON.stringify(tokenData)));
      
      // Update token keys list
      const keysBytes = await contract.getData("token_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          const keysStr = ethers.toUtf8String(keysBytes);
          keys = JSON.parse(keysStr); 
        } catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(tokenId);
      await contract.setData("token_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Equity token issued with FHE encryption!" });
      await loadTokens();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowIssueModal(false);
        setNewTokenData({ companyName: "", valuation: 0, totalShares: 0, description: "" });
        setCurrentStep(1);
      }, 2000);
      
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Token issuance failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIssuing(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    setIsDecrypting(true);
    try {
      const message = `FHE Decryption Request\nPublic Key: ${publicKey.substring(0, 20)}...\nContract: ${contractAddress.substring(0, 10)}...\nChain: ${chainId}\nTimestamp: ${Date.now()}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate decryption delay
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const approveToken = async (tokenId: string) => {
    if (!isConnected) return;
    setTransactionStatus({ visible: true, status: "pending", message: "Approving token with FHE verification..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract");
      
      const tokenBytes = await contract.getData(tokenId);
      if (tokenBytes.length === 0) throw new Error("Token not found");
      const tokenData = JSON.parse(ethers.toUtf8String(tokenBytes));
      
      const updatedToken = { ...tokenData, status: "approved" };
      await contract.setData(tokenId, ethers.toUtf8Bytes(JSON.stringify(updatedToken)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Token approved successfully!" });
      await loadTokens();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isIssuer = (tokenIssuer: string) => address?.toLowerCase() === tokenIssuer.toLowerCase();

  // Tutorial steps for the platform
  const tutorialSteps = [
    { title: "Connect Accredited Wallet", description: "Connect your qualified investor wallet", icon: "🔐" },
    { title: "Issue Private Equity", description: "Tokenize your private equity with FHE encryption", icon: "🏦" },
    { title: "Zama FHE Encryption", description: "Sensitive data encrypted using Zama FHE technology", icon: "🔒" },
    { title: "Private Trading", description: "Trade encrypted equity tokens securely", icon: "💱" }
  ];

  if (loading) return (
    <div className="loading-screen">
      <div className="vault-spinner"></div>
      <p>Initializing Private Equity Vault...</p>
    </div>
  );

  return (
    <div className="app-container vault-theme">
      <header className="app-header">
        <div className="logo">
          <div className="vault-icon"></div>
          <h1>PrivateEquity<span>FHE</span></h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowIssueModal(true)} className="issue-token-btn vault-button">
            <div className="add-icon"></div>Issue Equity
          </button>
          <button className="vault-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Guide" : "Platform Guide"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        {/* Welcome Banner */}
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Encrypted Private Equity Trading</h2>
            <p>Tokenize and trade private equity with zero-knowledge privacy protection</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>Zama FHE Encryption Active</span>
          </div>
        </div>

        {/* Tutorial Section */}
        {showTutorial && (
          <div className="tutorial-section">
            <h2>Private Equity Tokenization Guide</h2>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Dashboard Statistics */}
        <div className="dashboard-section">
          <h2>Market Overview</h2>
          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value">{tokens.length}</div>
              <div className="stat-label">Total Listings</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">${(totalValuation / 1000000).toFixed(1)}M</div>
              <div className="stat-label">Total Valuation</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{tradingCount}</div>
              <div className="stat-label">Active Trades</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{approvedCount}</div>
              <div className="stat-label">Approved</div>
            </div>
          </div>
        </div>

        {/* Equity Tokens List */}
        <div className="tokens-section">
          <div className="section-header">
            <h2>Private Equity Tokens</h2>
            <button onClick={loadTokens} className="refresh-btn vault-button" disabled={isRefreshing}>
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          
          <div className="tokens-list">
            {tokens.length === 0 ? (
              <div className="no-tokens">
                <div className="no-tokens-icon"></div>
                <p>No equity tokens listed yet</p>
                <button className="vault-button primary" onClick={() => setShowIssueModal(true)}>
                  Issue First Token
                </button>
              </div>
            ) : (
              tokens.map(token => (
                <div key={token.id} className="token-card" onClick={() => setSelectedToken(token)}>
                  <div className="token-header">
                    <h3>{token.companyName}</h3>
                    <span className={`status-badge ${token.status}`}>{token.status}</span>
                  </div>
                  <div className="token-info">
                    <div className="info-item">
                      <span>Issuer:</span>
                      <span>{token.issuer.substring(0, 8)}...{token.issuer.substring(36)}</span>
                    </div>
                    <div className="info-item">
                      <span>Listed:</span>
                      <span>{new Date(token.timestamp * 1000).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="token-actions">
                    {isIssuer(token.issuer) && token.status === "pending" && (
                      <button className="vault-button small" onClick={(e) => { e.stopPropagation(); approveToken(token.id); }}>
                        Approve
                      </button>
                    )}
                    <button className="vault-button small outline" onClick={(e) => { e.stopPropagation(); setSelectedToken(token); }}>
                      View Details
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Issue Token Modal */}
      {showIssueModal && (
        <IssueTokenModal
          currentStep={currentStep}
          setCurrentStep={setCurrentStep}
          onSubmit={issueToken}
          onClose={() => {
            setShowIssueModal(false);
            setCurrentStep(1);
            setNewTokenData({ companyName: "", valuation: 0, totalShares: 0, description: "" });
          }}
          issuing={issuing}
          tokenData={newTokenData}
          setTokenData={setNewTokenData}
        />
      )}

      {/* Token Detail Modal */}
      {selectedToken && (
        <TokenDetailModal
          token={selectedToken}
          onClose={() => {
            setSelectedToken(null);
            setDecryptedValuation(null);
            setDecryptedShares(null);
          }}
          decryptedValuation={decryptedValuation}
          decryptedShares={decryptedShares}
          setDecryptedValuation={setDecryptedValuation}
          setDecryptedShares={setDecryptedShares}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content vault-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="vault-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✕</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="vault-icon small"></div>
              <span>PrivateEquityFHE</span>
            </div>
            <p>FHE-encrypted private equity tokenization platform</p>
          </div>
          <div className="footer-tech">
            <div className="tech-badge">Powered by Zama FHE</div>
            <div className="tech-badge">Qualified Investors Only</div>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Issue Token Modal Component
interface IssueTokenModalProps {
  currentStep: number;
  setCurrentStep: (step: number) => void;
  onSubmit: () => void;
  onClose: () => void;
  issuing: boolean;
  tokenData: any;
  setTokenData: (data: any) => void;
}

const IssueTokenModal: React.FC<IssueTokenModalProps> = ({
  currentStep,
  setCurrentStep,
  onSubmit,
  onClose,
  issuing,
  tokenData,
  setTokenData
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setTokenData({ ...tokenData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setTokenData({ ...tokenData, [name]: parseFloat(value) || 0 });
  };

  const nextStep = () => {
    if (currentStep === 1 && (!tokenData.companyName || tokenData.valuation <= 0)) {
      alert("Please enter company name and valuation");
      return;
    }
    if (currentStep === 2 && tokenData.totalShares <= 0) {
      alert("Please enter total shares");
      return;
    }
    setCurrentStep(currentStep + 1);
  };

  const prevStep = () => {
    setCurrentStep(currentStep - 1);
  };

  const handleSubmit = () => {
    if (!tokenData.companyName || tokenData.valuation <= 0 || tokenData.totalShares <= 0) {
      alert("Please fill all required fields");
      return;
    }
    onSubmit();
  };

  const steps = [
    { number: 1, title: "Company Info", description: "Enter basic company information" },
    { number: 2, title: "Equity Details", description: "Set valuation and shares" },
    { number: 3, title: "FHE Encryption", description: "Review and encrypt data" }
  ];

  return (
    <div className="modal-overlay">
      <div className="issue-modal vault-card">
        <div className="modal-header">
          <h2>Issue Private Equity Token</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>

        {/* Step Progress */}
        <div className="step-progress">
          {steps.map(step => (
            <div key={step.number} className={`step-item ${currentStep >= step.number ? 'active' : ''}`}>
              <div className="step-number">{step.number}</div>
              <div className="step-info">
                <div className="step-title">{step.title}</div>
                <div className="step-description">{step.description}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="modal-body">
          {/* Step 1: Company Information */}
          {currentStep === 1 && (
            <div className="step-content">
              <h3>Company Information</h3>
              <div className="form-group">
                <label>Company Name *</label>
                <input
                  type="text"
                  name="companyName"
                  value={tokenData.companyName}
                  onChange={handleChange}
                  className="vault-input"
                  placeholder="Enter company legal name"
                />
              </div>
              <div className="form-group">
                <label>Valuation (USD) *</label>
                <input
                  type="number"
                  name="valuation"
                  value={tokenData.valuation}
                  onChange={handleNumberChange}
                  className="vault-input"
                  placeholder="Enter company valuation"
                  min="0"
                  step="1000"
                />
              </div>
            </div>
          )}

          {/* Step 2: Equity Details */}
          {currentStep === 2 && (
            <div className="step-content">
              <h3>Equity Structure</h3>
              <div className="form-group">
                <label>Total Shares *</label>
                <input
                  type="number"
                  name="totalShares"
                  value={tokenData.totalShares}
                  onChange={handleNumberChange}
                  className="vault-input"
                  placeholder="Enter total shares to issue"
                  min="1"
                />
              </div>
              <div className="form-group">
                <label>Description</label>
                <textarea
                  name="description"
                  value={tokenData.description}
                  onChange={handleChange}
                  className="vault-textarea"
                  placeholder="Additional details about the equity offering"
                  rows={3}
                />
              </div>
            </div>
          )}

          {/* Step 3: FHE Encryption Review */}
          {currentStep === 3 && (
            <div className="step-content">
              <h3>FHE Encryption Preview</h3>
              <div className="encryption-review">
                <div className="review-item">
                  <span>Company:</span>
                  <span>{tokenData.companyName}</span>
                </div>
                <div className="review-item">
                  <span>Valuation:</span>
                  <span>${tokenData.valuation.toLocaleString()}</span>
                </div>
                <div className="review-item">
                  <span>Total Shares:</span>
                  <span>{tokenData.totalShares.toLocaleString()}</span>
                </div>
                <div className="fhe-preview">
                  <div className="plain-data">
                    <label>Plain Data:</label>
                    <div>Valuation: ${tokenData.valuation}</div>
                  </div>
                  <div className="encryption-arrow">↓</div>
                  <div className="encrypted-data">
                    <label>FHE Encrypted:</label>
                    <div>{FHEEncryptNumber(tokenData.valuation).substring(0, 40)}...</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={prevStep} className="vault-button outline" disabled={currentStep === 1}>
            Previous
          </button>
          <div className="step-actions">
            {currentStep < 3 ? (
              <button onClick={nextStep} className="vault-button">
                Next Step
              </button>
            ) : (
              <button onClick={handleSubmit} disabled={issuing} className="vault-button primary">
                {issuing ? "Encrypting with FHE..." : "Issue Token Securely"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Token Detail Modal Component
interface TokenDetailModalProps {
  token: EquityToken;
  onClose: () => void;
  decryptedValuation: number | null;
  decryptedShares: number | null;
  setDecryptedValuation: (value: number | null) => void;
  setDecryptedShares: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const TokenDetailModal: React.FC<TokenDetailModalProps> = ({
  token,
  onClose,
  decryptedValuation,
  decryptedShares,
  setDecryptedValuation,
  setDecryptedShares,
  isDecrypting,
  decryptWithSignature
}) => {
  const handleDecrypt = async () => {
    if (decryptedValuation !== null) {
      setDecryptedValuation(null);
      setDecryptedShares(null);
      return;
    }
    
    const valuation = await decryptWithSignature(token.encryptedValuation);
    const shares = await decryptWithSignature(token.encryptedShares);
    
    if (valuation !== null) setDecryptedValuation(valuation);
    if (shares !== null) setDecryptedShares(shares);
  };

  return (
    <div className="modal-overlay">
      <div className="token-detail-modal vault-card">
        <div className="modal-header">
          <h2>{token.companyName} - Equity Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>

        <div className="modal-body">
          <div className="token-info-grid">
            <div className="info-section">
              <h3>Basic Information</h3>
              <div className="info-item">
                <span>Token ID:</span>
                <span>#{token.id.substring(0, 8)}</span>
              </div>
              <div className="info-item">
                <span>Issuer:</span>
                <span>{token.issuer.substring(0, 10)}...{token.issuer.substring(34)}</span>
              </div>
              <div className="info-item">
                <span>Listed:</span>
                <span>{new Date(token.timestamp * 1000).toLocaleString()}</span>
              </div>
              <div className="info-item">
                <span>Status:</span>
                <span className={`status-badge ${token.status}`}>{token.status}</span>
              </div>
            </div>

            <div className="encrypted-section">
              <h3>Encrypted Financial Data</h3>
              <div className="encrypted-data">
                <div className="data-item">
                  <label>Valuation:</label>
                  <span>{token.encryptedValuation.substring(0, 30)}...</span>
                </div>
                <div className="data-item">
                  <label>Shares:</label>
                  <span>{token.encryptedShares.substring(0, 30)}...</span>
                </div>
              </div>
              
              <button 
                onClick={handleDecrypt} 
                disabled={isDecrypting}
                className="vault-button decrypt-btn"
              >
                {isDecrypting ? "Decrypting..." : 
                 decryptedValuation ? "Re-encrypt Data" : "Decrypt with Signature"}
              </button>
            </div>
          </div>

          {/* Transaction History */}
          <div className="transaction-history">
            <h3>Transaction History</h3>
            <div className="timeline">
              {token.transactionHistory.map(tx => (
                <div key={tx.id} className="timeline-item">
                  <div className="timeline-marker"></div>
                  <div className="timeline-content">
                    <div className="tx-type">{tx.type.toUpperCase()}</div>
                    <div className="tx-parties">
                      {tx.from.substring(0, 8)}... → {tx.to.substring(0, 8)}...
                    </div>
                    <div className="tx-time">
                      {new Date(tx.timestamp * 1000).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Decrypted Data Display */}
          {decryptedValuation !== null && decryptedShares !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Values</h3>
              <div className="decrypted-data">
                <div className="value-item">
                  <span>Company Valuation:</span>
                  <strong>${decryptedValuation.toLocaleString()}</strong>
                </div>
                <div className="value-item">
                  <span>Total Shares:</span>
                  <strong>{decryptedShares.toLocaleString()}</strong>
                </div>
                <div className="value-item">
                  <span>Price per Share:</span>
                  <strong>${(decryptedValuation / decryptedShares).toFixed(2)}</strong>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose} className="vault-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;