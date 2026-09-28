// Jev Brain - Web3 AI Agent Platform & Decision Engine
// Multi-Model Routing, Dynamic DexScreener Tiers & Agent Warden

// ============================================
// GLOBAL STATE & STORAGE
// ============================================
let currentWallet = null;
let isTokenHolder = false;
let userTier = null;
let totalSavingsUsd = 0.00;
let currentChatId = null;
let allOpenRouterModels = [];
let discoveredProvider = null;
let currentUserProfile = null;
let activeGenerationController = null;
let pendingAttachment = null;
let speechRecognition = null;
let audioRecorder = null;
let audioChunks = [];

// Persistent Chats & Projects
const STORAGE_CHATS_KEY = 'jevbrain_chats_v2';
const STORAGE_ACTIVE_CHAT_KEY = 'jevbrain_active_chat_v2';
const STORAGE_WALLET_KEY = 'jevbrain_wallet';
const STORAGE_SESSION_TOKEN = 'jevbrain_session_token';

// Returns the wallet-signature-bound session token for authenticated API calls.
function getSessionToken() {
  return sessionStorage.getItem(STORAGE_SESSION_TOKEN) || 
         localStorage.getItem(STORAGE_SESSION_TOKEN) || 
         sessionStorage.getItem('jev_session_token') || 
         localStorage.getItem('jev_session_token') || '';
}

// Authenticated fetch headers (Bearer + X-Session-Token) for session-bound endpoints.
function authHeaders(extra = {}) {
  const token = getSessionToken();
  return token
    ? { ...extra, 'Authorization': `Bearer ${token}`, 'X-Session-Token': token }
    : { ...extra };
}
const STORAGE_PROFILE_PREFIX = 'jevbrain_profile_';
const STORAGE_TIER_PREFIX = 'jevbrain_tier_';
const STORAGE_PROJECTS_PREFIX = 'jevbrain_projects_';

// ============================================
// DOM SELECTORS
// ============================================
const elements = {
  center: document.getElementById('claude-center'),
  hero: document.getElementById('claude-hero'),
  heroHeading: document.getElementById('hero-heading'),
  messages: document.getElementById('messages-stream'),
  input: document.getElementById('prompt-input'),
  sendBtn: document.getElementById('send-btn'),
  modelSelect: document.getElementById('model-select'),
  modelInlineSearch: document.getElementById('model-inline-search'),
  attachBtn: document.getElementById('attach-btn'),
  attachmentInput: document.getElementById('attachment-input'),
  attachmentChip: document.getElementById('attachment-chip'),
  voiceBtn: document.getElementById('voice-input-btn'),
  audioBtn: document.getElementById('audio-record-btn'),
  newChatBtn: document.getElementById('new-chat-btn'),
  savedPill: document.getElementById('total-saved-pill'),
  collapseBtn: document.getElementById('collapse-sidebar-btn'),
  reopenBtn: document.getElementById('sidebar-reopen-btn'),
  sidebar: document.getElementById('sidebar'),
  gateOverlay: document.getElementById('wallet-gate-overlay'),
  connectBtn: document.getElementById('connect-wallet-btn'),
  connectSolanaBtn: document.getElementById('connect-solana-btn'),
  rainbowSolanaBtn: document.getElementById('rainbow-modal-solana-btn'),
  verifyBtn: document.getElementById('quick-verify-btn'),
  disconnectBtn: document.getElementById('disconnect-btn'),
  mc: document.getElementById('mc-display'),
  tier: document.getElementById('tier-display'),
  avatar: document.getElementById('user-avatar-badge'),
  name: document.getElementById('user-name-display'),
  status: document.getElementById('wallet-status-sub'),
  holder: document.getElementById('holder-status-text'),
  profileBar: document.getElementById('profile-bar'),
  chatsList: document.getElementById('chats-list'),
  topbarTitle: document.getElementById('topbar-title'),

  // Onboarding Modal
  onboardingModal: document.getElementById('onboarding-modal'),
  onboardingClose: document.getElementById('onboarding-modal-close'),
  onboardingForm: document.getElementById('onboarding-form'),
  onboardingNameInput: document.getElementById('onboarding-name-input'),
  onboardingEmailInput: document.getElementById('onboarding-email-input'),
  onboardingWalletAddr: document.getElementById('onboarding-wallet-addr'),
  onboardingConfirmBtn: document.getElementById('onboarding-confirm-btn'),

  // Modals
  tierModal: document.getElementById('tier-modal-overlay'),
  tierClose: document.getElementById('tier-modal-close'),
  tierPill: document.getElementById('tier-pill'),
  mcPill: document.getElementById('mc-pill'),

  projectsModal: document.getElementById('projects-modal'),
  projectsClose: document.getElementById('projects-modal-close'),
  navProjects: document.getElementById('nav-projects'),
  projectsList: document.getElementById('projects-list-container'),
  newProjName: document.getElementById('new-project-name'),
  newProjDesc: document.getElementById('new-project-desc'),
  btnCreateProject: document.getElementById('btn-create-project'),

  artifactsModal: document.getElementById('artifacts-modal'),
  artifactsClose: document.getElementById('artifacts-modal-close'),
  navArtifacts: document.getElementById('nav-artifacts'),
  artifactsList: document.getElementById('artifacts-sidebar-list'),
  artifactTitle: document.getElementById('artifact-preview-title'),
  artifactCode: document.getElementById('artifact-preview-code'),
  btnCopyArtifact: document.getElementById('btn-copy-artifact'),
  btnDownloadArtifact: document.getElementById('btn-download-artifact'),

  wardenModal: document.getElementById('warden-modal'),
  wardenClose: document.getElementById('warden-modal-close'),
  navWarden: document.getElementById('nav-code'),
  wardenInput: document.getElementById('warden-test-input'),
  btnRunWarden: document.getElementById('btn-run-warden-test'),
  wardenBox: document.getElementById('warden-verdict-box'),
  wardenBadge: document.getElementById('warden-verdict-badge'),
  wardenReason: document.getElementById('warden-verdict-reason'),
  wardenChkFile: document.getElementById('warden-chk-file'),
  wardenChkIrrev: document.getElementById('warden-chk-irrev'),
  wardenChkLoop: document.getElementById('warden-chk-loop'),
  wardenChkDone: document.getElementById('warden-chk-done'),

  routerModal: document.getElementById('router-modal'),
  routerClose: document.getElementById('router-modal-close'),
  navRouter: document.getElementById('nav-customize'),
  routerModelCount: document.getElementById('router-model-count'),
  routerModelSearch: document.getElementById('router-model-search'),
  routerModelsGrid: document.getElementById('router-models-grid'),

  searchModal: document.getElementById('search-modal'),
  searchClose: document.getElementById('search-modal-close'),
  chatSearchInput: document.getElementById('chat-search-input'),
  chatSearchResults: document.getElementById('chat-search-results'),
  btnExportJson: document.getElementById('btn-export-json'),
  btnExportMd: document.getElementById('btn-export-md'),
  btnProfileDownload: document.querySelector('.icon-mini[title*="Download"]'),
  btnProfileSearch: document.querySelector('.icon-mini[title*="Search"]'),

  // Holder Hub & Solana Rewards Elements
  rewardsModal: document.getElementById('rewards-modal'),
  rewardsClose: document.getElementById('rewards-modal-close'),
  navRewards: document.getElementById('nav-rewards'),
  rewardsCopyCa: document.getElementById('rewards-copy-ca'),
  rewardsTabs: document.getElementById('rewards-tabs'),
  btnTriggerAccrual: document.getElementById('btn-trigger-accrual'),
  btnRefreshEligibility: document.getElementById('btn-refresh-eligibility'),
  btnSubmitTransfer: document.getElementById('btn-submit-transfer'),
  btnSubmitRedeem: document.getElementById('btn-submit-redeem'),
  redeemCreditInput: document.getElementById('redeem-credit-input'),
  btnRefreshHistory: document.getElementById('btn-refresh-history'),
  btnLoadOperatorClaims: document.getElementById('btn-load-operator-claims'),
  btnConfirmOperatorTx: document.getElementById('btn-confirm-operator-tx')
};

// ============================================
// METAMASK & WEB3 WALLET DETECTION (EIP-6963 & Injected)
// ============================================
window.addEventListener('eip6963:announceProvider', (event) => {
  const info = event.detail.info;
  if (info) {
    if (info.rdns === 'io.metamask' || info.name.toLowerCase().includes('metamask')) {
      discoveredProvider = event.detail.provider;
      console.log('🦊 Official MetaMask provider detected via EIP-6963:', info.name);
    } else if (!discoveredProvider) {
      discoveredProvider = event.detail.provider;
      console.log('🌐 Web3 provider detected via EIP-6963:', info.name);
    }
  }
});

// Trigger discovery event
window.dispatchEvent(new Event('eip6963:requestProvider'));

function getWeb3Provider() {
  if (discoveredProvider) return discoveredProvider;
  if (typeof window.ethereum !== 'undefined') {
    if (Array.isArray(window.ethereum.providers)) {
      const metaMask = window.ethereum.providers.find(p => p.isMetaMask);
      if (metaMask) return metaMask;
      return window.ethereum.providers[0];
    }
    return window.ethereum;
  }
  return null;
}

function registerWalletProviderListeners() {
  const provider = getWeb3Provider();
  if (!provider?.on) return;
  provider.on('accountsChanged', (accounts) => {
    const next = accounts?.[0]?.toLowerCase();
    if (!next || (currentWallet && next !== currentWallet.toLowerCase())) {
      disconnectWallet();
      if (next) elements.status.textContent = 'Account changed — reconnect required';
    }
  });
  provider.on('chainChanged', () => {
    // Token balances and eligibility are network-specific. Never keep the old tier.
    if (currentWallet) {
      disconnectWallet();
      alert('Network changed. Please reconnect your wallet so Jev can verify the new network.');
    }
  });
}

// Convert string to hex for personal_sign parameters
function stringToHex(str) {
  let hex = '0x';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const n = code.toString(16);
    hex += (n.length < 2 ? '0' + n : n);
  }
  return hex;
}

// ============================================
// MOBILE DEVICE DETECTION & NATIVE WALLET DEEP LINKING
// ============================================
function isMobileDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = (navigator.userAgent || navigator.vendor || window.opera || '').toLowerCase();
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);
  return isMobileUA || (isTouch && window.innerWidth <= 820);
}

function buildPhantomDeepLink(targetUrl = window.location.href) {
  try {
    const url = new URL(targetUrl, window.location.origin);
    url.searchParams.set('auto_connect', 'phantom');
    const dappUrl = url.toString();
    const ref = window.location.origin;
    return `https://phantom.app/ul/browse/${encodeURIComponent(dappUrl)}?ref=${encodeURIComponent(ref)}`;
  } catch (err) {
    return 'https://phantom.app/';
  }
}

function buildMetaMaskDeepLink(targetUrl = window.location.href) {
  try {
    const url = new URL(targetUrl, window.location.origin);
    url.searchParams.set('auto_connect', 'metamask');
    const hostAndPath = (url.host + url.pathname + (url.search || '') + (url.hash || '')).replace(/^\/+/, '');
    return `https://metamask.app.link/dapp/${hostAndPath}`;
  } catch (err) {
    return 'https://metamask.io/download/';
  }
}

function openMobileWalletDeepLink(walletType) {
  const isPhantom = walletType === 'phantom';
  const appName = isPhantom ? 'Phantom' : 'MetaMask';
  const deepLink = isPhantom ? buildPhantomDeepLink() : buildMetaMaskDeepLink();
  
  // Show a modern mobile handoff banner with direct tap action
  const toastId = 'wallet-mobile-handoff';
  let existing = document.getElementById(toastId);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const banner = document.createElement('div');
  banner.id = toastId;
  banner.style.position = 'fixed';
  banner.style.bottom = '24px';
  banner.style.left = '50%';
  banner.style.transform = 'translateX(-50%)';
  banner.style.zIndex = '999999';
  banner.style.width = '92%';
  banner.style.maxWidth = '390px';
  banner.style.background = '#18181b';
  banner.style.color = '#fafafa';
  banner.style.border = '1px solid rgba(255,255,255,0.18)';
  banner.style.borderRadius = '12px';
  banner.style.padding = '14px 16px';
  banner.style.boxShadow = '0 12px 36px rgba(0,0,0,0.7)';
  banner.style.fontFamily = 'var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)';
  banner.style.textAlign = 'center';
  banner.innerHTML = `
    <div style="font-size:13.5px; font-weight:600; margin-bottom:6px; display:flex; align-items:center; justify-content:center; gap:8px;">
      <span style="font-size:16px;">📱</span>
      Opening ${appName} Mobile App...
    </div>
    <div style="font-size:11.5px; color:#a1a1aa; margin-bottom:12px; line-height:1.45;">
      Redirecting to your installed ${appName} app to sign &amp; authenticate securely.
    </div>
    <div style="display:flex; gap:8px; justify-content:center;">
      <a href="${deepLink}" style="display:inline-flex; align-items:center; gap:6px; background:${isPhantom ? '#7c3aed' : '#f97316'}; color:#fff; font-size:12px; font-weight:600; padding:8px 16px; border-radius:8px; text-decoration:none; box-shadow:0 2px 8px rgba(0,0,0,0.3);">
        Open ${appName} App ↗
      </a>
      <button id="close-handoff-banner" style="background:transparent; border:1px solid rgba(255,255,255,0.2); color:#a1a1aa; font-size:12px; padding:8px 12px; border-radius:8px; cursor:pointer;">
        Dismiss
      </button>
    </div>
  `;

  document.body.appendChild(banner);
  document.getElementById('close-handoff-banner')?.addEventListener('click', () => {
    if (banner.parentNode) banner.parentNode.removeChild(banner);
  });

  // Attempt instant navigation to deep link
  try {
    window.location.href = deepLink;
  } catch (err) {
    console.warn('Direct deep link navigation failed:', err);
  }

  // Auto-dismiss after 15 seconds if user stays on page
  setTimeout(() => {
    if (banner.parentNode) banner.parentNode.removeChild(banner);
  }, 15000);
}

// Expose on window for debugging & testing
if (typeof window !== 'undefined') {
  window.isMobileDevice = isMobileDevice;
  window.buildPhantomDeepLink = buildPhantomDeepLink;
  window.buildMetaMaskDeepLink = buildMetaMaskDeepLink;
  window.openMobileWalletDeepLink = openMobileWalletDeepLink;
}

// ============================================
// METAMASK WALLET CONNECTION & SIGNATURE AUTHENTICATION
// ============================================
async function connectMetaMaskWallet() {
  const provider = getWeb3Provider();
  if (!provider) {
    if (isMobileDevice()) {
      openMobileWalletDeepLink('metamask');
      return;
    }
    const install = confirm('MetaMask is required to authenticate with Jev Brain.\n\nClick OK to open https://metamask.io/download/ and install MetaMask.');
    if (install) {
      window.open('https://metamask.io/download/', '_blank');
    }
    return;
  }

  const btn = elements.connectBtn;
  const originalHtml = btn ? btn.innerHTML : '';

  try {
    if (btn) {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin-icon">
          <line x1="12" y1="2" x2="12" y2="6"></line>
          <line x1="12" y1="18" x2="12" y2="22"></line>
          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
          <line x1="2" y1="12" x2="6" y2="12"></line>
          <line x1="18" y1="12" x2="22" y2="12"></line>
          <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
          <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
        </svg>
        <span>Requesting Accounts...</span>
      `;
      btn.disabled = true;
    }

    // Step 1: Request accounts popup (eth_requestAccounts)
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts[0]) {
      throw new Error('No Ethereum account selected in MetaMask.');
    }
    const account = accounts[0].toLowerCase();

    if (btn) {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <span>Sign Message in MetaMask...</span>
      `;
    }

    // Step 2: Request challenge nonce from backend
    const nonceRes = await fetch(`/api/wallet/nonce?address=${encodeURIComponent(account)}`);
    if (!nonceRes.ok) {
      throw new Error('Failed to generate authentication challenge from server.');
    }
    const { nonce, message } = await nonceRes.json();

    // Step 3: Prompt cryptographic personal_sign signature in MetaMask
    let signature = null;
    const msgHex = stringToHex(message);
    try {
      // Standard personal_sign: params [hexMessage, account]
      signature = await provider.request({
        method: 'personal_sign',
        params: [msgHex, account]
      });
    } catch (hexErr) {
      // Fallback for providers expecting plain text: params [message, account]
      signature = await provider.request({
        method: 'personal_sign',
        params: [message, account]
      });
    }

    if (!signature) {
      throw new Error('Cryptographic signature was rejected or cancelled.');
    }

    if (btn) {
      btn.innerHTML = '<span>⏳</span> <span>Verifying Signature...</span>';
    }

    // Step 4: Verify cryptographic signature on backend
    const verifyRes = await fetch('/api/wallet/verify-signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: account,
        signature,
        message,
      })
    });

    const verifyData = await verifyRes.json();
    if (!verifyRes.ok || !verifyData.success) {
      throw new Error(verifyData.error || 'Cryptographic signature verification failed.');
    }

    if (verifyData.sessionToken) {
      sessionStorage.setItem(STORAGE_SESSION_TOKEN, verifyData.sessionToken);
      localStorage.setItem(STORAGE_SESSION_TOKEN, verifyData.sessionToken);
      sessionStorage.setItem('jev_session_token', verifyData.sessionToken);
      localStorage.setItem('jev_session_token', verifyData.sessionToken);
    }

    // Step 5: Unlock UI and update state
    await onWalletAuthenticated(verifyData.address, verifyData.tokensHeld, verifyData.userTier);

  } catch (err) {
    console.error('MetaMask authentication error:', err);
    if (err.code === 4001) {
      alert('MetaMask request rejected by user.');
    } else {
      alert('MetaMask Error: ' + (err.message || err));
    }
  } finally {
    if (btn) {
      btn.innerHTML = originalHtml || `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
        </svg>
        <span>Connect MetaMask</span>
      `;
      btn.disabled = false;
    }
  }
}

// ============================================
// SLEEK NON-BLOCKING IN-APP TOAST NOTIFICATION
// ============================================
function showNotification(message, type = 'info') {
  let container = document.getElementById('app-notification-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'app-notification-toast-container';
    container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;display:flex;flex-direction:column;gap:10px;max-width:420px;pointer-events:none;';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  const bg = type === 'error' ? '#1e111a' : type === 'success' ? '#0f291e' : '#141e2e';
  const border = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#00f0ff';
  const textCol = type === 'error' ? '#fca5a5' : type === 'success' ? '#6ee7b7' : '#93c5fd';
  const icon = type === 'error' ? '⚠️' : type === 'success' ? '✅' : 'ℹ️';

  toast.style.cssText = `
    background: ${bg};
    border: 1px solid ${border};
    color: #f1f5f9;
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 13px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6), 0 0 12px ${border}33;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    opacity: 0;
    transform: translateY(16px);
    transition: all 0.25s ease-out;
    pointer-events: auto;
  `;

  const msgDiv = document.createElement('div');
  msgDiv.style.cssText = 'display:flex;align-items:center;gap:10px;word-break:break-word;line-height:1.4;';
  
  const iconSpan = document.createElement('span');
  iconSpan.textContent = icon;
  msgDiv.appendChild(iconSpan);

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  textSpan.style.color = textCol;
  msgDiv.appendChild(textSpan);

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.style.cssText = 'background:none;border:none;color:#94a3b8;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;margin-left:8px;';
  closeBtn.onmouseover = () => { closeBtn.style.color = '#fff'; };
  closeBtn.onmouseout = () => { closeBtn.style.color = '#94a3b8'; };

  function removeToast() {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(16px)';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 250);
  }

  closeBtn.onclick = removeToast;

  toast.appendChild(msgDiv);
  toast.appendChild(closeBtn);
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  setTimeout(removeToast, 4500);
}

// ============================================
// PHANTOM (SOLANA) WALLET & ON-CHAIN HOLDER AUTHENTICATION
// ============================================
async function connectSolanaWallet() {
  const solana = window.phantom?.solana?.isPhantom 
    ? window.phantom.solana 
    : (window.solana?.isPhantom ? window.solana : window.solana);

  if (!solana) {
    if (isMobileDevice()) {
      openMobileWalletDeepLink('phantom');
      return;
    }
    showNotification('Phantom wallet extension is required for Solana authentication. Redirecting to Phantom download...', 'info');
    setTimeout(() => window.open('https://phantom.app/download', '_blank'), 600);
    return;
  }

  const btn = elements.connectSolanaBtn || document.getElementById('connect-solana-btn');
  const originalHtml = btn ? btn.innerHTML : '';

  try {
    if (btn) {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin-icon">
          <line x1="12" y1="2" x2="12" y2="6"></line>
          <line x1="12" y1="18" x2="12" y2="22"></line>
          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line>
          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line>
          <line x1="2" y1="12" x2="6" y2="12"></line>
          <line x1="18" y1="12" x2="22" y2="12"></line>
          <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line>
          <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line>
        </svg>
        <span>Connecting Phantom...</span>
      `;
      btn.disabled = true;
    }

    let pubkey;
    if (solana.isConnected && solana.publicKey) {
      pubkey = solana.publicKey.toString();
    } else {
      const resp = await solana.connect();
      pubkey = (resp?.publicKey || solana.publicKey).toString();
    }

    // Instant VIP Authority Check: Zero restrictions, no signatures, instant unlock
    if (pubkey === 'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn') {
      const vipKey = `jev_live_vip_${pubkey}`;
      sessionStorage.setItem(STORAGE_SESSION_TOKEN, vipKey);
      localStorage.setItem(STORAGE_SESSION_TOKEN, vipKey);
      sessionStorage.setItem('jev_session_token', vipKey);
      localStorage.setItem('jev_session_token', vipKey);
      localStorage.setItem(STORAGE_WALLET_KEY, pubkey);
      localStorage.setItem('jev_wallet_address', pubkey);

      const vipTier = {
        tierId: 5,
        tierLevel: 5,
        tierName: 'Dynasty Magnate (VIP Whitelist)',
        tokensHeld: 1000000,
        bagUsdValue: '$50,000+',
        creditRatePerHour: 5000,
        allowedModels: ['all'],
        isWhitelisted: true
      };
      await onWalletAuthenticated(pubkey, 1000000, vipTier);
      showNotification(`VIP Authority Active (${pubkey.slice(0, 4)}...${pubkey.slice(-4)})`, 'success');
      return;
    }

    if (btn) {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <span>Sign Message in Phantom...</span>
      `;
    }

    // Step 1: Request authentication challenge nonce from server
    const nonceRes = await fetch(`/api/wallet/nonce?address=${encodeURIComponent(pubkey)}`);
    const nonceText = await nonceRes.text();
    let nonceData;
    try {
      nonceData = JSON.parse(nonceText);
    } catch (parseErr) {
      throw new Error('The verification server returned an invalid response. It may be waking up — please try again in a few seconds.');
    }
    if (!nonceRes.ok || !nonceData.message) {
      throw new Error(nonceData.error || 'Failed to generate challenge nonce from server.');
    }
    const { nonce, message } = nonceData;

    // Step 2: Sign message using Solana Ed25519 standard
    const encoded = new TextEncoder().encode(message);
    const isUserRejection = (e) => e && (e.code === 4001 || e?.data?.code === 4001);
    const extractErrMsg = (e) => {
      if (!e) return '';
      if (typeof e === 'string') return e;
      return e.message || e?.data?.message || (e.code ? `Wallet error code ${e.code}` : '');
    };

    // Phantom's legacy signMessage() wrapper is known to throw generic
    // "Unexpected error" in several extension versions. The standard wallet
    // request API is the reliable path, with legacy + delayed retry fallbacks.
    const requestSignature = async () =>
      solana.request({ method: 'signMessage', params: { message: encoded, display: 'utf8' } });

    let signResult;
    const errorsSeen = [];
    try {
      signResult = await requestSignature();
    } catch (reqErr) {
      if (isUserRejection(reqErr)) throw reqErr;
      errorsSeen.push(reqErr);
      try {
        signResult = await solana.signMessage(encoded, 'utf8');
      } catch (signErr) {
        if (isUserRejection(signErr)) throw signErr;
        errorsSeen.push(signErr);
        // One delayed retry — transient extension popup hiccups often resolve
        await new Promise(r => setTimeout(r, 600));
        try {
          signResult = await requestSignature();
        } catch (retryErr) {
          if (isUserRejection(retryErr)) throw retryErr;
          errorsSeen.push(retryErr);
          const detail = errorsSeen.map(extractErrMsg).find(Boolean) || '';
          if (/unexpected error/i.test(detail)) {
            throw new Error('Phantom could not complete the signature request. Make sure the Phantom extension is unlocked, that no popup was blocked, then try again. If it persists, restart the Phantom extension or update it from phantom.app.');
          }
          throw new Error(detail ? `Phantom could not sign the message: ${detail}` : 'Phantom could not sign the message. Make sure your wallet is unlocked and try again.');
        }
      }
    }
    const rawSig = signResult?.signature || signResult;
    let sigBytes;
    try {
      sigBytes = new Uint8Array(rawSig);
    } catch (convErr) {
      throw new Error('Phantom returned an invalid signature format. Please update your Phantom extension and try again.');
    }
    if (!sigBytes || sigBytes.length === 0) {
      throw new Error('Phantom returned an empty signature. Please unlock your wallet and try again.');
    }
    const sigHex = Array.from(sigBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (btn) {
      btn.innerHTML = '<span>⏳</span> <span>Verifying On-Chain Holding...</span>';
    }

    // Step 3: Verify signature and on-chain SPL token balance on backend
    const verifyRes = await fetch('/api/wallet/verify-signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: pubkey,
        signature: sigHex,
        message: message,
      })
    });

    const verifyText = await verifyRes.text();
    let verifyData;
    try {
      verifyData = JSON.parse(verifyText);
    } catch (parseErr) {
      throw new Error(verifyRes.ok
        ? 'The server returned an invalid verification response. Please try again.'
        : `Token verification failed (HTTP ${verifyRes.status}). The server may be waking up — please retry in a few seconds.`);
    }
    if (!verifyRes.ok || !verifyData.success) {
      throw new Error(verifyData.error || 'Token verification failed. Only holders can unlock AI features.');
    }

    if (verifyData.sessionToken) {
      sessionStorage.setItem(STORAGE_SESSION_TOKEN, verifyData.sessionToken);
      localStorage.setItem(STORAGE_SESSION_TOKEN, verifyData.sessionToken);
      sessionStorage.setItem('jev_session_token', verifyData.sessionToken);
      localStorage.setItem('jev_session_token', verifyData.sessionToken);
    }

    // Step 4: Unlock UI and update state
    await onWalletAuthenticated(verifyData.address, verifyData.tokensHeld, verifyData.userTier);
    showNotification(`Phantom verified! Tier: ${verifyData.userTier?.tierName || 'Holder'}`, 'success');

  } catch (err) {
    console.error('Solana wallet authentication error:', err);
    const errCode = err?.code ?? err?.data?.code;
    if (errCode === 4001) {
      showNotification('Phantom request was cancelled by user.', 'info');
    } else {
      const detail = (typeof err === 'string' ? err : err?.message || err?.data?.message || '')
        || 'An unexpected wallet error occurred. Check the browser console for details.';
      showNotification('Solana Verification: ' + detail, 'error');
    }
  } finally {
    if (btn) {
      btn.innerHTML = originalHtml || `
        <svg width="16" height="16" viewBox="0 0 128 128" fill="none">
          <circle cx="64" cy="64" r="64" fill="#7C3AED"/>
          <path d="M107.5 67.5C104.5 48.5 88.5 35 69.5 35C48 35 30.5 52.5 30.5 74C30.5 90 40 101.5 54 101.5C59 101.5 61 98.5 65.5 98.5C70 98.5 72 101.5 77 101.5C92 101.5 109 89 107.5 67.5ZM51 68C47.7 68 45 65.3 45 62C45 58.7 47.7 56 51 56C54.3 56 57 58.7 57 62C57 65.3 54.3 68 51 68ZM77 68C73.7 68 71 65.3 71 62C71 58.7 73.7 56 77 56C80.3 56 83 58.7 83 62C83 65.3 80.3 68 77 68Z" fill="white"/>
        </svg>
        <span>Phantom (Solana)</span>
      `;
      btn.disabled = false;
    }
  }
}

// ============================================
// USER PROFILE & FIRST-TIME ONBOARDING
// ============================================
async function getUserProfile(address) {
  if (!address) return null;
  const key = STORAGE_PROFILE_PREFIX + address.toLowerCase();
  const local = localStorage.getItem(key);
  if (local) {
    try {
      return JSON.parse(local);
    } catch (e) {}
  }

  // Fallback to server (session-bound: profile reads require own signed session)
  try {
    const res = await fetch(`/api/user/profile?address=${encodeURIComponent(address)}`, {
      headers: { 'Authorization': `Bearer ${getSessionToken()}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.profile) {
        localStorage.setItem(key, JSON.stringify(data.profile));
        return data.profile;
      }
    }
  } catch (e) {}

  return null;
}

async function saveUserProfile(address, name, email) {
  const cleanName = (name || '').trim();
  const cleanEmail = (email || '').trim();
  const profile = {
    address: address,
    name: cleanName,
    email: cleanEmail,
    updatedAt: Date.now()
  };

  currentUserProfile = profile;
  const key = STORAGE_PROFILE_PREFIX + address.toLowerCase();
  localStorage.setItem(key, JSON.stringify(profile));

  // Sync to backend (session-bound: a wallet can only write its own profile)
  try {
    await fetch('/api/user/profile', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getSessionToken()}`
      },
      body: JSON.stringify(profile)
    });
  } catch (e) {
    console.error('Failed to sync profile to server:', e);
  }

  applyUserProfile(profile);
}

function applyUserProfile(profile) {
  if (!profile) return;
  const name = profile.name || 'User';
  const initial = name.charAt(0).toUpperCase();

  // Sidebar profile info
  if (elements.name) elements.name.textContent = name;
  if (elements.status) elements.status.textContent = 'MetaMask Verified';
  if (elements.avatar) elements.avatar.textContent = initial;

  // Main Page / Hero Welcome text
  if (elements.heroHeading) {
    elements.heroHeading.textContent = `Hey, welcome to Jev, ${name}!`;
  }

  // Re-render chat messages if chat is open to reflect user's name
  if (currentChatId) {
    loadChatMessages(currentChatId);
  }
}

function promptOnboarding(address) {
  if (!elements.onboardingModal) return;
  elements.onboardingModal.style.display = 'flex';
  if (elements.onboardingWalletAddr) {
    elements.onboardingWalletAddr.textContent = address.slice(0, 6) + '...' + address.slice(-4);
  }
  if (currentUserProfile) {
    if (elements.onboardingNameInput) elements.onboardingNameInput.value = currentUserProfile.name || '';
    if (elements.onboardingEmailInput) elements.onboardingEmailInput.value = currentUserProfile.email || '';
  } else {
    if (elements.onboardingNameInput) elements.onboardingNameInput.value = '';
    if (elements.onboardingEmailInput) elements.onboardingEmailInput.value = '';
  }
  setTimeout(() => {
    elements.onboardingNameInput?.focus();
  }, 100);
}

async function onWalletAuthenticated(address, tokens = 0, precalculatedTier = null) {
  try {
    let tierData = precalculatedTier;
    if (!tierData) {
      const cachedTier = localStorage.getItem(STORAGE_TIER_PREFIX + address.toLowerCase());
      if (cachedTier) tierData = JSON.parse(cachedTier);
      else throw new Error('Wallet session expired. Please reconnect MetaMask.');
    }

    currentWallet = address;
    isTokenHolder = true;
    userTier = tierData;
    refreshInlineModelOptions(elements.modelInlineSearch?.value || '');

    // Unlock UI
    elements.gateOverlay.style.display = 'none';
    const shortAddr = address.slice(0, 6) + '...' + address.slice(-4);

    // Check user profile: first-time onboarding vs returning user
    const profile = await getUserProfile(address);
    if (profile && profile.name) {
      currentUserProfile = profile;
      applyUserProfile(profile);
      if (elements.onboardingModal) elements.onboardingModal.style.display = 'none';
    } else {
      // First time connect: open Claude AI style onboarding modal
      elements.name.textContent = 'Setting up...';
      elements.status.textContent = 'Profile Setup';
      elements.avatar.textContent = '✻';
      promptOnboarding(address);
    }

    if (elements.holder) {
      elements.holder.textContent = 'Verified Holder';
      elements.holder.style.color = '#10b981';
    }
    if (elements.tier) {
      elements.tier.textContent = `${userTier.tierName || 'Dynasty Magnate'} (Unlocked)`;
    }

    // Topbar Connect Button update
    const topbarBtn = document.getElementById('topbar-connect-wallet-btn');
    const topbarText = document.getElementById('topbar-wallet-btn-text');
    if (topbarBtn) topbarBtn.classList.add('connected');
    if (topbarText) topbarText.textContent = shortAddr;

    // Web3 Modal update
    const rBadge = document.getElementById('rainbow-modal-badge');
    const rAddr = document.getElementById('rainbow-modal-address');
    const rTier = document.getElementById('rainbow-modal-tier-text');
    const rConnBtn = document.getElementById('rainbow-modal-connect-btn');
    const rSolanaBtn = document.getElementById('rainbow-modal-solana-btn');
    const rDiscBtn = document.getElementById('rainbow-modal-disconnect-btn');
    if (rBadge) {
      rBadge.textContent = 'Verified Holder';
      rBadge.style.background = 'rgba(16,185,129,0.15)';
      rBadge.style.color = '#10b981';
    }
    if (rAddr) rAddr.textContent = address;
    if (rTier) rTier.textContent = `Tier: ${userTier.tierName || 'Dynasty Magnate'} • Unlocked Full Access`;
    if (rConnBtn) rConnBtn.style.display = 'none';
    if (rSolanaBtn) rSolanaBtn.style.display = 'none';
    if (rDiscBtn) rDiscBtn.style.display = 'block';

    const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    if (elements.status) {
      elements.status.textContent = isSol ? 'Solana Verified' : 'MetaMask Verified';
    }

    localStorage.setItem(STORAGE_WALLET_KEY, address);
    localStorage.setItem('jev_wallet_address', address);
    sessionStorage.setItem(STORAGE_WALLET_KEY, address);
    sessionStorage.setItem('jev_wallet_address', address);
    localStorage.setItem(STORAGE_TIER_PREFIX + address.toLowerCase(), JSON.stringify(userTier));
    console.log(`✓ Wallet Verified! Tier: [${userTier.tierName}] Bag: ${userTier.bagUsdValue}`);
    loadServerChats(address);
    loadRewardsHubData();
  } catch (err) {
    console.error('Verification failure:', err);
  }
}

function disconnectWallet() {
  currentWallet = null;
  isTokenHolder = false;
  userTier = null;
  currentUserProfile = null;
  localStorage.removeItem(STORAGE_WALLET_KEY);
  localStorage.removeItem('jev_wallet_address');
  sessionStorage.removeItem(STORAGE_WALLET_KEY);
  sessionStorage.removeItem('jev_wallet_address');
  sessionStorage.removeItem(STORAGE_SESSION_TOKEN);
  localStorage.removeItem(STORAGE_SESSION_TOKEN);
  sessionStorage.removeItem('jev_session_token');
  localStorage.removeItem('jev_session_token');

  if (elements.heroHeading) {
    elements.heroHeading.textContent = 'Welcome! I’m Jev Brain.';
  }
  if (elements.onboardingModal) {
    elements.onboardingModal.style.display = 'none';
  }

  elements.gateOverlay.style.display = 'flex';
  elements.name.textContent = 'Not Connected';
  elements.status.textContent = 'Access Restricted';
  elements.avatar.textContent = '?';
  if (elements.tier) elements.tier.textContent = 'Locked';
  if (elements.holder) {
    elements.holder.textContent = 'Disconnected';
    elements.holder.style.color = '#dc2626';
  }

  const topbarBtn = document.getElementById('topbar-connect-wallet-btn');
  const topbarText = document.getElementById('topbar-wallet-btn-text');
  if (topbarBtn) topbarBtn.classList.remove('connected');
  if (topbarText) topbarText.textContent = 'Connect Wallet';

  const rBadge = document.getElementById('rainbow-modal-badge');
  const rAddr = document.getElementById('rainbow-modal-address');
  const rTier = document.getElementById('rainbow-modal-tier-text');
  const rConnBtn = document.getElementById('rainbow-modal-connect-btn');
  const rSolanaBtn = document.getElementById('rainbow-modal-solana-btn');
  const rDiscBtn = document.getElementById('rainbow-modal-disconnect-btn');
  if (rBadge) {
    rBadge.textContent = 'Disconnected';
    rBadge.style.background = 'rgba(239,68,68,0.15)';
    rBadge.style.color = '#ef4444';
  }
  if (rAddr) rAddr.textContent = 'No wallet connected';
  if (rTier) rTier.textContent = 'Requires token holding to access frontier AI models';
  if (rConnBtn) rConnBtn.style.display = 'flex';
  if (rSolanaBtn) rSolanaBtn.style.display = 'flex';
  if (rDiscBtn) rDiscBtn.style.display = 'none';
}

// ============================================
// CHATS & MULTI-SESSION MANAGER
// ============================================
function getSavedChats() {
  try {
    const raw = localStorage.getItem(STORAGE_CHATS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveChats(chats) {
  localStorage.setItem(STORAGE_CHATS_KEY, JSON.stringify(chats));
}

function getActiveChatId() {
  return localStorage.getItem(STORAGE_ACTIVE_CHAT_KEY) || null;
}

function setActiveChatId(id) {
  localStorage.setItem(STORAGE_ACTIVE_CHAT_KEY, id);
  currentChatId = id;
}

function initChats() {
  let chats = getSavedChats();
  if (chats.length === 0) {
    const initial = {
      id: 'chat-initial',
      title: 'Your first chat with Jev Brain',
      messages: [],
      createdAt: Date.now()
    };
    chats = [initial];
    saveChats(chats);
  }

  const activeId = getActiveChatId() || chats[0].id;
  setActiveChatId(activeId);
  renderChatsList();
  loadChatMessages(activeId);
}

function renderChatsList() {
  const chats = getSavedChats();
  elements.chatsList.innerHTML = '';

  chats.forEach((chat) => {
    const item = document.createElement('div');
    const isActive = chat.id === currentChatId;
    item.className = `chat-thread-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <span class="thread-dot">${isActive ? '●' : '○'}</span>
      <span class="thread-title" title="${escapeHtml(chat.title)}">${escapeHtml(chat.title)}</span>
    `;

    item.addEventListener('click', () => {
      if (!isTokenHolder) { elements.gateOverlay.style.display = 'flex'; return; }
      setActiveChatId(chat.id);
      renderChatsList();
      loadChatMessages(chat.id);
    });

    elements.chatsList.appendChild(item);
  });
}

function loadChatMessages(chatId) {
  const chats = getSavedChats();
  const chat = chats.find(c => c.id === chatId) || chats[0];
  if (!chat) return;

  elements.messages.innerHTML = '';
  if (elements.topbarTitle) elements.topbarTitle.textContent = chat.title;

  if (chat.messages && chat.messages.length > 0) {
    if (elements.hero) elements.hero.style.display = 'none';
    chat.messages.forEach(msg => {
      if (msg.role === 'user') {
        appendUserMessage(msg.content, false);
      } else {
        appendAssistantResponse(msg, false);
      }
    });
  } else {
    if (elements.hero) elements.hero.style.display = 'flex';
  }
}

function createNewChat() {
  if (!isTokenHolder) {
    elements.gateOverlay.style.display = 'flex';
    return;
  }

  const chats = getSavedChats();
  const newChatObj = {
    id: 'chat-' + Date.now(),
    title: 'New chat',
    messages: [],
    createdAt: Date.now()
  };

  chats.unshift(newChatObj);
  saveChats(chats);
  setActiveChatId(newChatObj.id);

  elements.messages.innerHTML = '';
  if (elements.hero) elements.hero.style.display = 'flex';
  if (elements.input) {
    elements.input.value = '';
    elements.input.focus();
  }
  if (elements.topbarTitle) elements.topbarTitle.textContent = 'New chat';

  renderChatsList();
}

function saveMessageToCurrentChat(role, payload) {
  const chats = getSavedChats();
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat) return;

  chat.messages.push({
    role,
    content: typeof payload === 'string' ? payload : payload.response,
    modelName: payload.modelName,
    latencyMs: payload.latencyMs,
    dollarsSaved: payload.dollarsSaved,
    timestamp: Date.now()
  });

  // Auto-generate title from first user query
  if (role === 'user' && chat.messages.filter(m => m.role === 'user').length === 1) {
    const raw = typeof payload === 'string' ? payload : payload.content;
    chat.title = raw.length > 30 ? raw.slice(0, 30) + '...' : raw;
    if (elements.topbarTitle) elements.topbarTitle.textContent = chat.title;
  }

  saveChats(chats);
  renderChatsList();
  // Fire-and-forget server sync (session-bound; server ignores any address in body).
  if (getSessionToken()) {
    const savedChat = chats.find(item => item.id === currentChatId);
    fetch('/api/chats', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ chat: savedChat })
    }).catch(() => {});
  }
}

// Merge this wallet's server-stored chats into the local list after auth.
async function loadServerChats(address) {
  if (!getSessionToken()) return;
  try {
    const res = await fetch('/api/chats', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const serverChats = Array.isArray(data.chats) ? data.chats : [];
    if (!serverChats.length) return;

    const local = getSavedChats();
    let merged = false;
    for (const sc of serverChats) {
      const existing = local.find(c => c.id === sc.id);
      if (!existing) {
        local.push(sc);
        merged = true;
      } else if ((sc.messages || []).length > (existing.messages || []).length) {
        local[local.indexOf(existing)] = sc;
        merged = true;
      }
    }
    if (merged) {
      saveChats(local);
      renderChatsList();
      if (currentChatId) loadChatMessages(currentChatId);
    }
  } catch (e) {
    console.warn('Server chat sync unavailable:', e.message);
  }
}

// ============================================
// CHAT SEND & EXECUTION
// ============================================
async function handleSubmit() {
  if (!isTokenHolder || !currentWallet) {
    elements.gateOverlay.style.display = 'flex';
    return;
  }

  const text = elements.input.value.trim();
  if (!text && !pendingAttachment) return;
  const attachmentContext = pendingAttachment?.text ? `\n\nAttached file (${pendingAttachment.name}):\n${pendingAttachment.text.slice(0, 120000)}` : '';
  const promptText = `${text}${attachmentContext}`.trim();

  if (elements.hero) elements.hero.style.display = 'none';
  appendUserMessage(text || `Attached ${pendingAttachment.name}`, true);
  elements.input.value = '';
  elements.input.style.height = '38px';
  pendingAttachment = null;
  if (elements.attachmentChip) elements.attachmentChip.hidden = true;

  if (activeGenerationController) {
    activeGenerationController.abort();
    activeGenerationController = null;
    if (elements.sendBtn) {
      elements.sendBtn.title = 'Send (Enter)';
      const sendIcon = elements.sendBtn.querySelector('.send-icon');
      const stopIcon = elements.sendBtn.querySelector('.stop-icon');
      if (sendIcon) sendIcon.style.display = 'block';
      if (stopIcon) stopIcon.style.display = 'none';
    }
    return;
  }
  const loadingRow = appendLoading();
  activeGenerationController = new AbortController();
  if (elements.sendBtn) {
    elements.sendBtn.title = 'Stop generation';
    const sendIcon = elements.sendBtn.querySelector('.send-icon');
    const stopIcon = elements.sendBtn.querySelector('.stop-icon');
    if (sendIcon) sendIcon.style.display = 'none';
    if (stopIcon) stopIcon.style.display = 'block';
  }
  elements.center.scrollTop = elements.center.scrollHeight;

  try {
    const model = elements.modelSelect.value;
    const sessionToken = sessionStorage.getItem(STORAGE_SESSION_TOKEN) || localStorage.getItem(STORAGE_SESSION_TOKEN) || '';
    const res = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': sessionToken ? `Bearer ${sessionToken}` : '',
        'X-Session-Token': sessionToken
      },
      body: JSON.stringify({
        prompt: promptText,
        model,
        walletAddress: currentWallet,
        sessionToken
      }),
      signal: activeGenerationController.signal
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error || 'API request failed: ' + res.status);
    }

    loadingRow.remove();
    const streamRow = appendStreamingAssistant();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseText = '';
    let finalData = null;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const event of events) {
        const line = event.split('\n').find(item => item.startsWith('data:'));
        if (!line) continue;
        const packet = JSON.parse(line.slice(5).trim());
        if (packet.error) throw new Error(packet.error);
        if (packet.token) {
          responseText += packet.token;
          streamRow.querySelector('.msg-bubble-assistant').innerHTML = formatMarkdown(responseText);
          elements.center.scrollTop = elements.center.scrollHeight;
        }
        if (packet.done) finalData = packet;
      }
    }
    finalData = finalData || { response: responseText, modelName: 'Jev Gateway', latencyMs: 0, dollarsSaved: 0 };
    streamRow.querySelector('.routing-header-pill span').innerHTML = `
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:4px;">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
      </svg>${escapeHtml(finalData.modelName || model)} • ${finalData.latencyMs || 0}ms • Saved $${(finalData.dollarsSaved || 0).toFixed(4)}
    `;
    saveMessageToCurrentChat('assistant', { ...finalData, response: responseText });

    totalSavingsUsd += (finalData.dollarsSaved || 0);
    elements.savedPill.textContent = `Saved $${totalSavingsUsd.toFixed(4)}`;

    // Live credit sync: any chat (web OR CLI) debits the same wallet ledger, so refresh
    // the Holder Hub balance in the background right after each completed generation.
    if (typeof loadRewardsHubData === 'function') {
      loadRewardsHubData().catch(() => {});
    }

    // Extract any code block as artifact
    extractAndSaveArtifact(text, responseText);

  } catch (err) {
    loadingRow.remove();
    if (err.name !== 'AbortError') {
      appendAssistantResponse({
        response: `I couldn't complete that request. ${err.message}`,
        modelName: 'Jev Gateway',
        latencyMs: 0,
        dollarsSaved: 0
      }, true);
    }
  }

  activeGenerationController = null;
  if (elements.sendBtn) {
    elements.sendBtn.title = 'Send (Enter)';
    const sendIcon = elements.sendBtn.querySelector('.send-icon');
    const stopIcon = elements.sendBtn.querySelector('.stop-icon');
    if (sendIcon) sendIcon.style.display = 'block';
    if (stopIcon) stopIcon.style.display = 'none';
  }

  elements.center.scrollTop = elements.center.scrollHeight;
}

function appendStreamingAssistant() {
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML = '<div class="routing-header-pill"><span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:4px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>Jev Gateway • streaming...</span></div><div class="msg-bubble-assistant"></div>';
  elements.messages.appendChild(row);
  return row;
}

function appendUserMessage(text, shouldSave = true) {
  const row = document.createElement('div');
  row.className = 'msg-row user';
  const userName = (currentUserProfile && currentUserProfile.name) ? currentUserProfile.name : 'You';
  const userInitial = userName.charAt(0).toUpperCase();
  row.innerHTML = `
    <div class="msg-user-header">
      <span class="msg-user-name">${escapeHtml(userName)}</span>
      <span class="msg-user-avatar-mini">${escapeHtml(userInitial)}</span>
    </div>
    <div class="msg-bubble-user">${escapeHtml(text)}</div>
  `;
  elements.messages.appendChild(row);
  if (shouldSave) saveMessageToCurrentChat('user', text);
}

function appendAssistantResponse(data, shouldSave = true) {
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  const pillHtml = data.modelName ? 
    `<div class="routing-header-pill"><span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:4px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>${escapeHtml(data.modelName)} • ${data.latencyMs}ms • Saved $${(data.dollarsSaved || 0).toFixed(4)}</span></div>` : 
    '';
  row.innerHTML = `${pillHtml}<div class="msg-bubble-assistant">${formatMarkdown(data.response || '')}</div>`;
  elements.messages.appendChild(row);
  if (shouldSave) saveMessageToCurrentChat('assistant', data);
}

function appendLoading() {
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML = `<div class="routing-header-pill"><span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-1px;margin-right:4px;"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>Jev Routing...</span></div><div class="msg-bubble-assistant"><span>Analyzing complexity and routing model...</span></div>`;
  elements.messages.appendChild(row);
  return row;
}

function extractAndSaveArtifact(userPrompt, responseText) {
  if (!responseText) return;
  const match = responseText.match(/```([a-z0-9_-]*)\n([\s\S]*?)```/);
  if (match) {
    const lang = match[1] || 'javascript';
    const code = match[2].trim();
    fetch('/api/artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        title: userPrompt.slice(0, 32) + ' snippet',
        type: 'code',
        language: lang,
        code
      })
    }).catch(() => {});
  }
}

// ============================================
// PROJECTS MANAGER (REAL API)
// ============================================
async function openProjectsModal() {
  elements.projectsModal.style.display = 'flex';
  renderProjectsList(getLocalProjects());

  if (currentWallet && getSessionToken()) {
    try {
      const res = await fetch('/api/projects', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.projects) && data.projects.length > 0) {
          saveLocalProjects(data.projects);
          renderProjectsList(data.projects);
        }
      }
    } catch (e) {
      console.warn('Projects sync error:', e);
    }
  }
}

function getLocalProjects() {
  if (!currentWallet) return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_PROJECTS_PREFIX + currentWallet.toLowerCase()) || '[]');
  } catch {
    return [];
  }
}

function saveLocalProjects(projects) {
  if (!currentWallet) return;
  localStorage.setItem(STORAGE_PROJECTS_PREFIX + currentWallet.toLowerCase(), JSON.stringify(projects));
}

function renderProjectsList(projects) {
  elements.projectsList.innerHTML = '';
  if (projects.length === 0) {
    elements.projectsList.innerHTML = `<div style="font-size:12px;color:var(--text-muted);padding:12px 0;">${currentWallet ? 'No projects created yet. Create your first workspace above.' : 'Connect your wallet to create and access your private projects.'}</div>`;
    return;
  }

  projects.forEach(p => {
    const card = document.createElement('div');
    card.className = 'project-item-card';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong style="font-size:13px;font-family:var(--font-serif);">${escapeHtml(p.name)}</strong>
        <span style="font-size:10px;color:var(--text-muted);">${p.createdAt || '2026-09-19'}</span>
      </div>
      <div style="font-size:11.5px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(p.description || 'Workspace container')}</div>
      <div style="font-size:10.5px;color:var(--accent-terracotta);margin-top:4px;font-weight:600;">✓ Active Workspace</div>
    `;
    card.addEventListener('click', () => {
      elements.projectsModal.style.display = 'none';
      if (elements.topbarTitle) elements.topbarTitle.textContent = `${p.name} • Project`;
    });
    elements.projectsList.appendChild(card);
  });
}

async function handleCreateProject() {
  if (!currentWallet) {
    elements.gateOverlay.style.display = 'flex';
    return;
  }
  const name = elements.newProjName.value.trim();
  const desc = elements.newProjDesc.value.trim();
  if (!name) { alert('Enter a project name'); return; }

  const newProj = {
    id: `project-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`,
    name,
    description: desc,
    createdAt: new Date().toISOString().slice(0, 10),
    chatCount: 0
  };

  const projects = getLocalProjects();
  projects.unshift(newProj);
  saveLocalProjects(projects);
  elements.newProjName.value = '';
  elements.newProjDesc.value = '';
  renderProjectsList(projects);

  if (getSessionToken()) {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ name, description: desc })
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.projects)) {
          saveLocalProjects(data.projects);
          renderProjectsList(data.projects);
        }
      }
    } catch (e) {
      console.warn('Project save sync error:', e);
    }
  }
}

// ============================================
// ARTIFACTS GALLERY (REAL PREVIEW & SAVE)
// ============================================
let loadedArtifacts = [];
let selectedArtifactIndex = 0;

async function openArtifactsModal() {
  elements.artifactsModal.style.display = 'flex';

  try {
    const res = await fetch('/api/artifacts', { headers: authHeaders() });
    const data = await res.json();
    loadedArtifacts = data.artifacts || [];
    renderArtifactsGallery();
  } catch (e) {
    console.error('Artifacts fetch error:', e);
  }
}

function renderArtifactsGallery() {
  elements.artifactsList.innerHTML = '';
  if (loadedArtifacts.length === 0) {
    elements.artifactsList.innerHTML = '<div style="font-size:11px;color:var(--text-muted);">No artifacts generated yet.</div>';
    return;
  }

  loadedArtifacts.forEach((art, idx) => {
    const item = document.createElement('div');
    const isActive = idx === selectedArtifactIndex;
    item.className = `artifact-list-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <div style="font-weight:600;">${escapeHtml(art.title)}</div>
      <div style="font-size:10px;color:var(--text-muted);">${art.language || 'code'} • ${art.createdAt || '2026-09-19'}</div>
    `;
    item.addEventListener('click', () => {
      selectedArtifactIndex = idx;
      renderArtifactsGallery();
    });
    elements.artifactsList.appendChild(item);
  });

  const activeArt = loadedArtifacts[selectedArtifactIndex] || loadedArtifacts[0];
  if (activeArt) {
    elements.artifactTitle.textContent = activeArt.title;
    elements.artifactCode.textContent = activeArt.code || '// No code';
  }
}

function copyActiveArtifact() {
  const activeArt = loadedArtifacts[selectedArtifactIndex];
  if (activeArt && activeArt.code) {
    navigator.clipboard.writeText(activeArt.code);
    elements.btnCopyArtifact.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      <span>Copied!</span>
    `;
    setTimeout(() => {
      elements.btnCopyArtifact.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <span>Copy</span>
      `;
    }, 1500);
  }
}

function downloadActiveArtifact() {
  const activeArt = loadedArtifacts[selectedArtifactIndex];
  if (!activeArt) return;
  const blob = new Blob([activeArt.code || ''], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ext = activeArt.language === 'json' ? 'json' : activeArt.language === 'markdown' ? 'md' : 'js';
  a.download = `${activeArt.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================
// AGENT WARDEN PRE-FLIGHT TEST BENCH
// ============================================
function openWardenModal() {
  elements.wardenModal.style.display = 'flex';
}

async function runWardenCheck(commandToTest) {
  const cmd = commandToTest || elements.wardenInput.value.trim();
  if (!cmd) return;

  elements.btnRunWarden.textContent = 'Evaluating...';
  try {
    const res = await fetch('/api/warden-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });

    const data = await res.json();
    elements.wardenBox.style.display = 'block';

    const decision = data.decision || 'AUTO_ALLOW';
    elements.wardenBadge.textContent = decision;
    elements.wardenReason.textContent = data.reasons?.join(' | ') || 'Command verified safe.';

    if (decision === 'BLOCKED_RISKY') {
      elements.wardenBadge.style.background = 'rgba(225, 29, 72, 0.15)';
      elements.wardenBadge.style.color = '#e11d48';
    } else if (decision === 'NEEDS_CONFIRM') {
      elements.wardenBadge.style.background = 'rgba(245, 158, 11, 0.15)';
      elements.wardenBadge.style.color = '#b45309';
    } else {
      elements.wardenBadge.style.background = 'rgba(16, 185, 129, 0.15)';
      elements.wardenBadge.style.color = '#059669';
    }

    const q = data.questions || {};
    const checks = data.checks || {};
    const fileCheck = checks.fileCheck || q.is_right_file || {};
    const irrevCheck = checks.irrevCheck || q.is_irreversible || {};
    const loopCheck = checks.loopCheck || q.are_we_looping || {};
    const doneCheck = checks.doneCheck || q.are_we_done || {};

    const isFileSafe = fileCheck.ok !== false;
    elements.wardenChkFile.textContent = `1. File: ${isFileSafe ? '✓ Safe' : '✗ Protected'}`;
    elements.wardenChkFile.style.color = isFileSafe ? '#059669' : '#e11d48';

    const isIrreversible = irrevCheck.irreversible === true;
    elements.wardenChkIrrev.textContent = `2. Irreversible: ${isIrreversible ? '✗ Dangerous' : '✓ Safe'}`;
    elements.wardenChkIrrev.style.color = isIrreversible ? '#e11d48' : '#059669';

    const isLooping = loopCheck.looping === true;
    elements.wardenChkLoop.textContent = `3. Loop: ${isLooping ? '✗ Loop' : '✓ OK'}`;
    elements.wardenChkLoop.style.color = isLooping ? '#e11d48' : '#059669';

    const isDone = doneCheck.done === true;
    elements.wardenChkDone.textContent = `4. Finished: ${isDone ? '✓ Done' : '○ Ongoing'}`;

  } catch (e) {
    alert('Warden check failed');
  } finally {
    elements.btnRunWarden.textContent = 'Evaluate';
  }
}

// ============================================
// MODEL ROUTER & TIER HOLDING FIREWALL
// ============================================
let currentRouterTierFilter = 'all';

function isModelUnlockedForClient(model) {
  if (!isTokenHolder || !currentWallet || !userTier) {
    return false; // Requires connected wallet with on-chain token holding
  }
  const allowed = userTier.allowedModels || [];
  if (allowed.includes('all')) return true; // Dynasty Magnate / Whale
  if (allowed.some(rule => rule === model.id || model.id.startsWith(rule))) return true;

  const userLevel = Number(userTier.tierId) || (userTier.tierName === 'Wallet Member' ? 1 : 0);
  const modelReqTier = Number(model.tierId) || 1;
  return userLevel >= modelReqTier;
}

async function openRouterModal() {
  elements.routerModal.style.display = 'flex';

  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    if (data.status === 'maintenance' || (Array.isArray(data.models) && data.models.length === 0)) {
      if (elements.routerModelsGrid) {
        elements.routerModelsGrid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 24px;color:var(--text-secondary);font-size:13px;">
          <div style="font-size:24px;margin-bottom:12px;">🛠️</div>
          <strong style="color:var(--text-primary);font-size:14px;display:block;margin-bottom:6px;">No Models Found</strong>
          ${escapeHtml(data.message || 'Backend infrastructure upgrade is currently undergoing maintenance.')}
        </div>`;
      }
      if (elements.routerModelCount) elements.routerModelCount.textContent = '0 (Maintenance)';
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Unable to load OpenRouter models');
    allOpenRouterModels = data.models || [];
    renderModelRouterGrid(allOpenRouterModels);
  } catch (e) {
    elements.routerModelsGrid.innerHTML = `<div style="grid-column:1/-1;color:#b91c1c;font-size:12px;padding:12px;">${escapeHtml(e.message)}</div>`;
  }
}

function renderModelRouterGrid(modelsList) {
  if (!elements.routerModelsGrid) return;
  elements.routerModelsGrid.innerHTML = '';
  const models = Array.isArray(modelsList) ? modelsList : [];

  const countEl = document.getElementById('router-model-count');
  if (countEl) countEl.textContent = `${models.length}+`;

  // Update user tier holding status bar
  const userTierNameEl = document.getElementById('router-user-tier-name');
  const unlockedCountEl = document.getElementById('router-unlocked-count');

  let unlockedCount = 0;
  models.forEach(m => {
    if (isModelUnlockedForClient(m)) unlockedCount++;
  });

  if (userTierNameEl) {
    if (isTokenHolder && userTier) {
      userTierNameEl.textContent = `${userTier.tierName || 'Dynasty Magnate'} (Tier ${userTier.tierId || 1})`;
      userTierNameEl.style.color = '#059669';
    } else {
      userTierNameEl.textContent = 'Guest / Disconnected (0 $JEVBRAIN)';
      userTierNameEl.style.color = 'var(--status-error)';
    }
  }

  if (unlockedCountEl) {
    if (isTokenHolder && userTier) {
      unlockedCountEl.textContent = `${unlockedCount} of ${models.length} Unlocked`;
      unlockedCountEl.style.color = '#059669';
    } else {
      unlockedCountEl.textContent = 'All Locked (Hold $JEVBRAIN to Unlock)';
      unlockedCountEl.style.color = 'var(--status-error)';
    }
  }

  models.forEach(m => {
    const isUnlocked = isModelUnlockedForClient(m);
    const card = document.createElement('div');
    card.className = `router-model-card ${isUnlocked ? 'unlocked' : 'locked'}`;
    card.setAttribute('data-tier', String(m.tierId || 1));
    card.setAttribute('data-unlocked', isUnlocked ? 'true' : 'false');
    card.setAttribute('data-id', m.id);

    const tierBadgeClass = `badge-tier-${m.tierId || 1}`;
    const costPer1M = (Number(m.pricing?.prompt || 0) * 1000000).toFixed(2);

    card.innerHTML = `
      <div>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:2px;">
          <strong style="font-size:11.5px;color:var(--text-primary);line-height:1.3;">${escapeHtml(m.name || m.id)}</strong>
          <span class="card-tier-badge ${tierBadgeClass}">${escapeHtml(m.tierName || 'Tier ' + (m.tierId || 1))}</span>
        </div>
        <div style="font-size:9.5px;color:var(--text-muted);font-family:var(--font-mono);word-break:break-all;">${escapeHtml(m.id)}</div>
        <div style="font-size:9.5px;color:var(--text-tertiary);margin-top:3px;line-height:1.3;">
          ${escapeHtml(m.description || (m.architecture?.modality === 'multimodal' ? 'Multimodal Vision & Text' : 'High-Speed Reasoning Engine'))}
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;padding-top:4px;border-top:1px solid var(--border-subtle);">
        <span style="font-size:9.5px;color:var(--text-muted);font-family:var(--font-mono);">$${costPer1M}/1M</span>
        <span class="card-status-pill ${isUnlocked ? 'unlocked' : 'locked'}">
          ${isUnlocked ? '✓ Unlocked' : '🔒 Locked'}
        </span>
      </div>
    `;

    card.addEventListener('click', () => {
      if (!isUnlocked) {
        alert(`Access Restricted:\n\nModel '${m.name}' requires [${m.tierName || 'Tier ' + m.tierId}] ($JEVBRAIN holding required).\n\nYour current holding tier: [${userTier?.tierName || 'Guest'}].\n\nPlease acquire $JEVBRAIN tokens on Solana or select an unlocked model.`);
        return;
      }

      if (![...elements.modelSelect.options].some(opt => opt.value === m.id)) {
        elements.modelSelect.add(new Option(m.name || m.id, m.id));
      }
      elements.modelSelect.value = m.id;
      if (elements.routerModal) elements.routerModal.style.display = 'none';
    });

    elements.routerModelsGrid.appendChild(card);
  });

  filterRouterModels();
}

function filterRouterModels() {
  if (!elements.routerModelsGrid) return;
  const q = (elements.routerModelSearch?.value || '').trim().toLowerCase();
  const activeTab = currentRouterTierFilter || 'all';

  const cards = elements.routerModelsGrid.querySelectorAll('.router-model-card');
  let visibleCount = 0;

  cards.forEach(card => {
    const text = card.textContent.toLowerCase();
    const cardTier = card.getAttribute('data-tier');
    const isUnlocked = card.getAttribute('data-unlocked') === 'true';

    const matchesQuery = !q || text.includes(q);
    let matchesTier = true;
    if (activeTab === 'unlocked') {
      matchesTier = isUnlocked;
    } else if (activeTab !== 'all') {
      matchesTier = cardTier === activeTab;
    }

    const show = matchesQuery && matchesTier;
    card.style.display = show ? 'flex' : 'none';
    if (show) visibleCount++;
  });
}

function refreshInlineModelOptions(query = '') {
  if (!elements.modelSelect || !allOpenRouterModels.length) return;
  const selected = elements.modelSelect.value;
  const needle = query.trim().toLowerCase();

  const filtered = allOpenRouterModels.filter(model => {
    const haystack = `${model.id} ${model.name || ''} ${model.tierName || ''}`.toLowerCase();
    return !needle || haystack.includes(needle);
  }).slice(0, 120);

  elements.modelSelect.innerHTML = '<option value="auto">Jev Router • Auto (Dynamic Triage)</option>';

  filtered.forEach(model => {
    const unlocked = isModelUnlockedForClient(model);
    const opt = document.createElement('option');
    opt.value = model.id;
    if (unlocked) {
      opt.textContent = `[Tier ${model.tierId || 1}] ${model.name || model.id}`;
    } else {
      opt.textContent = `[🔒 Locked · ${model.tierName || 'Tier ' + model.tierId}] ${model.name || model.id}`;
      opt.disabled = true; // Prevents choosing locked models
    }
    elements.modelSelect.appendChild(opt);
  });

  if ([...elements.modelSelect.options].some(opt => opt.value === selected && !opt.disabled)) {
    elements.modelSelect.value = selected;
  }
}

async function loadOpenRouterModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    if (res.ok) {
      if (data.status === 'maintenance' || (Array.isArray(data.models) && data.models.length === 0)) {
        allOpenRouterModels = [];
        if (elements.modelSelect) {
          elements.modelSelect.innerHTML = '<option value="auto" selected>No models found • Backend infrastructure upgrade underway</option>';
          elements.modelSelect.disabled = true;
        }
        if (elements.routerModelCount) {
          elements.routerModelCount.textContent = '0 (Maintenance)';
        }
        return;
      }
      if (Array.isArray(data.models)) {
        allOpenRouterModels = data.models;
        refreshInlineModelOptions(elements.modelInlineSearch?.value || '');
      }
    }
  } catch (err) {
    console.warn('Model catalog unavailable:', err.message);
  }
}

// ============================================
// HOLDER HUB & SOLANA REWARDS ENGINE
// ============================================
const SOL_PER_CREDIT = 0.00001; // Standard reference: 100,000 credits = 1.0 SOL (1 credit = 10,000 lamports)

async function openRewardsModal() {
  if (!elements.rewardsModal) return;
  elements.rewardsModal.style.display = 'flex';
  switchRewardsTab('overview');
  await loadRewardsHubData();
  await loadRewardsLedgerHistory();
}

async function openRewardsModalWithTab(tabName = 'transfer') {
  if (!elements.rewardsModal) return;
  elements.rewardsModal.style.display = 'flex';
  switchRewardsTab(tabName);
  await loadRewardsHubData();
  await loadRewardsLedgerHistory();
}

function switchRewardsTab(tabName) {
  const tabs = elements.rewardsTabs?.querySelectorAll('.tier-tab-btn') || [];
  tabs.forEach(btn => {
    if (btn.getAttribute('data-tab') === tabName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  ['overview', 'transfer', 'redeem', 'boost', 'history', 'cli', 'operator'].forEach(name => {
    const pane = document.getElementById(`pane-rewards-${name}`);
    if (pane) pane.style.display = (name === tabName) ? 'block' : 'none';
  });

  if (tabName === 'transfer') {
    switchP2PSubTab('buy');
    updateP2PModalAvailDisplay();
    loadP2PMarketOrders();
  } else if (tabName === 'history') {
    loadRewardsLedgerHistory();
  } else if (tabName === 'boost') {
    loadBoostStatus();
  } else if (tabName === 'operator') {
    loadOperatorClaims();
  } else if (tabName === 'cli') {
    loadCliKeyData();
  }
}

async function loadRewardsHubData() {
  const addrDisplay = document.getElementById('hub-wallet-addr');
  const tokenDisplay = document.getElementById('hub-token-balance');
  const tierDisplay = document.getElementById('hub-tier-name');
  const modalTag = document.getElementById('rewards-modal-tier-tag');
  const availDisplay = document.getElementById('hub-avail-credits');
  const rateDisplay = document.getElementById('hub-rate-credits');
  const earnedDisplay = document.getElementById('hub-earned-credits');
  const usedDisplay = document.getElementById('hub-used-credits');
  const actionStatus = document.getElementById('hub-action-status');

  if (!currentWallet) {
    if (addrDisplay) addrDisplay.textContent = 'Not connected';
    if (actionStatus) actionStatus.innerHTML = '<span style="color:#ef4444;">Please connect your Solana wallet to access Holder Hub.</span>';
    return;
  }

  if (addrDisplay) addrDisplay.textContent = currentWallet;
  if (actionStatus) actionStatus.textContent = 'Syncing on-chain holdings & ledger balance...';

  try {
    // 0. Fetch Live Pool Status & Market Cap
    try {
      const poolRes = await fetch('/api/pool/status');
      if (poolRes.ok) {
        const poolData = await poolRes.json();
        const mcFormatted = `$${Number(poolData.marketCapUsd || 0).toLocaleString()}`;
        const hubMcEl = document.getElementById('hub-live-mc');
        const burnMcEl = document.getElementById('burn-live-mc');
        const burnPoolEl = document.getElementById('burn-live-pool');
        if (hubMcEl) hubMcEl.textContent = mcFormatted;
        if (burnMcEl) burnMcEl.textContent = mcFormatted;
        if (burnPoolEl) {
          burnPoolEl.textContent = `${Number(poolData.rewardPool?.distributablePoolSol || 0).toFixed(4)} SOL`;
        }
      }
    } catch (e) {
      console.warn('Pool status fetch error:', e);
    }

    // 1. Fetch Eligibility & Token Balance
    const eligRes = await fetch(`/api/holder/eligibility?address=${encodeURIComponent(currentWallet)}`, { headers: authHeaders() });
    const eligData = await eligRes.json();

    if (eligRes.ok) {
      const tokens = eligData.balanceUi !== undefined ? eligData.balanceUi : (eligData.balanceTokens || 0);
      const tierLabel = eligData.tier || eligData.tierName || 'Free';
      const tierNum = eligData.tierLevel !== undefined ? eligData.tierLevel : (eligData.tier || 0);
      const hourlyRate = eligData.creditRatePerHour !== undefined ? eligData.creditRatePerHour : (eligData.accrualRatePerHour || 0);
      const per15mRate = eligData.creditRatePer15Min !== undefined ? eligData.creditRatePer15Min : Math.round(Number(hourlyRate || 0) / 4);

      if (tokenDisplay) tokenDisplay.textContent = `${Number(tokens).toLocaleString()} $JEVBRAIN`;
      if (tierDisplay) tierDisplay.textContent = `${tierLabel} (Tier ${tierNum})`;
      if (modalTag) modalTag.textContent = tierLabel;
      if (rateDisplay) rateDisplay.innerHTML = `${per15mRate} <span style="font-size:10px;font-weight:normal;color:var(--text-tertiary);">/ 15m (${hourlyRate}/hr)</span>`;
    }

    // 2. Fetch Credit Account Balance
    const balUrl = currentWallet ? `/api/credits/balance?address=${encodeURIComponent(currentWallet)}` : '/api/credits/balance';
    const balRes = await fetch(balUrl, { headers: authHeaders() });
    if (balRes.ok) {
      const balData = await balRes.json();
      const userAvail = Number(balData.availableCredits || 0);
      if (availDisplay) availDisplay.textContent = userAvail.toLocaleString();
      if (earnedDisplay) earnedDisplay.textContent = Number(balData.earnedCredits || 0).toLocaleString();
      const usedTotal = (Number(balData.usedCredits || 0) + Number(balData.redeemedCredits || 0) + Number(balData.transferredCredits || 0));
      if (usedDisplay) usedDisplay.textContent = usedTotal.toLocaleString();
      updateP2PModalAvailDisplay();

      const burnMaxHint = document.getElementById('burn-max-hint');
      const burnSlider = document.getElementById('burn-credit-slider');
      if (burnMaxHint) burnMaxHint.textContent = `Available: ${userAvail.toLocaleString()}`;
      if (burnSlider) {
        burnSlider.max = Math.max(10, userAvail);
        if (parseInt(burnSlider.value, 10) > userAvail) {
          burnSlider.value = Math.max(10, Math.min(100, userAvail));
          const inputEl = document.getElementById('redeem-credit-input');
          if (inputEl) inputEl.value = burnSlider.value;
        }
      }

      // 3. Display Boost Multiplier Status in Overview & Alert Banner
      const boost = balData.boost || null;
      const boostBadge = document.getElementById('hub-boost-badge');
      const isBoosted = boost && Number(boost.multiplier) > 1.0;
      const boostBanner = document.getElementById('boost-status-banner');

      if (boostBadge) {
        if (isBoosted) {
          boostBadge.innerHTML = `<span style="color:#10b981;">⚡ ${Number(boost.multiplier).toFixed(1)}x Multiplier (Active)</span>`;
        } else {
          boostBadge.textContent = '1.0x (Standard)';
        }
      }

      if (boostBanner) {
        const tokens = eligData?.balanceUi !== undefined ? eligData.balanceUi : (eligData?.balanceTokens || 0);
        if (isBoosted) {
          boostBanner.style.display = 'block';
          boostBanner.style.border = '1px solid rgba(16, 185, 129, 0.35)';
          boostBanner.style.background = 'rgba(16, 185, 129, 0.08)';
          boostBanner.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:18px;">⚡</span>
                <div>
                  <div style="font-weight:700;color:#10b981;font-size:12px;">2.0x Titan Multiplier Activated</div>
                  <div style="color:var(--text-secondary);font-size:11px;">You are receiving 2.0x credit accrual on the basis of your verified token burn supply.</div>
                </div>
              </div>
              <span style="background:rgba(16,185,129,0.15);color:#10b981;font-family:var(--font-mono);font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:4px;white-space:nowrap;">2.0x ACTIVE</span>
            </div>
          `;
        } else if (Number(tokens) > 0) {
          boostBanner.style.display = 'block';
          boostBanner.style.border = '1px solid rgba(245, 158, 11, 0.4)';
          boostBanner.style.background = 'rgba(245, 158, 11, 0.08)';
          boostBanner.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="font-size:18px;">⚠️</span>
                <div>
                  <div style="font-weight:700;color:#f59e0b;font-size:12px;">You are not getting 2x on the basis of your burn supply</div>
                  <div style="color:var(--text-secondary);font-size:11px;">Your wallet is earning standard 1.0x base emissions. Burn your tier token quota to permanently unlock 2.0x Lifetime Multiplier!</div>
                </div>
              </div>
              <button class="btn-dark-primary" style="font-size:11px;padding:5px 12px;font-weight:600;white-space:nowrap;" onclick="switchRewardsTab('boost')">🔥 Burn Now for 2.0x</button>
            </div>
          `;
        } else {
          boostBanner.style.display = 'none';
        }
      }

      if (rateDisplay && boost && Number(boost.multiplier) > 1.0) {
        const baseRate = Number(eligData?.creditRatePerHour || 0);
        if (baseRate > 0) {
          const boostedRate = Math.round(baseRate * Number(boost.multiplier));
          const boosted15m = Math.round(boostedRate / 4);
          rateDisplay.innerHTML = `${boosted15m} <span style="font-size:10px;font-weight:normal;color:#10b981;">/ 15m (${boostedRate}/hr · ⚡ ${boost.multiplier}x)</span>`;
        }
      }

      if (actionStatus) actionStatus.textContent = '';
      updateRedeemPreview();
    } else {
      if (actionStatus) actionStatus.innerHTML = '<span style="color:var(--text-tertiary);">Session authentication required for ledger balances.</span>';
    }
  } catch (err) {
    console.warn('Rewards Hub sync error:', err);
    if (actionStatus) actionStatus.textContent = 'Could not sync holdings.';
  }
}

// Live credit sync: while the Holder Hub modal is open, auto-refresh balances every 30s so
// usage from the local CLI (or another device/session) appears without a manual refresh.
setInterval(() => {
  if (elements.rewardsModal && elements.rewardsModal.style.display === 'flex' && getSessionToken()) {
    loadRewardsHubData().catch(() => {});
  }
}, 30000);

async function triggerCreditAccrual() {
  const actionStatus = document.getElementById('hub-action-status');
  if (actionStatus) actionStatus.textContent = 'Calculating deterministic accrual...';

  try {
    const res = await fetch('/api/credits/accrue', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ walletAddress: currentWallet })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to accrue credits');

    if (actionStatus) {
      const gained = Number(data.accruedAmount || 0);
      // Surface the server's accrual reason (e.g. verification outage / interval pending)
      // instead of a misleading green "+0 credits!" when nothing accrued.
      actionStatus.innerHTML = gained > 0
        ? `<span style="color:#10b981;font-weight:600;">⚡ Accrued +${gained} credits! (Available: ${data.availableCredits})</span>`
        : `<span style="color:#f59e0b;font-weight:600;">⏳ ${escapeHtml(data.reason || 'No new credits yet — next accrual window is still pending.')}</span>`;
    }
    await loadRewardsHubData();
    await loadRewardsLedgerHistory();
  } catch (err) {
    if (actionStatus) actionStatus.innerHTML = `<span style="color:#ef4444;">${escapeHtml(err.message)}</span>`;
  }
}

async function submitCreditTransfer() {
  const toInput = document.getElementById('transfer-to-address');
  const amtInput = document.getElementById('transfer-credit-amount');
  const statusMsg = document.getElementById('transfer-status-msg');

  const toAddress = toInput?.value.trim();
  const amount = parseInt(amtInput?.value, 10);

  if (!toAddress) {
    if (statusMsg) statusMsg.innerHTML = '<span style="color:#ef4444;">Please provide a valid recipient Solana address.</span>';
    return;
  }
  if (!amount || amount <= 0) {
    if (statusMsg) statusMsg.innerHTML = '<span style="color:#ef4444;">Amount must be a positive integer.</span>';
    return;
  }

  if (statusMsg) statusMsg.textContent = 'Broadcasting atomic transfer...';

  try {
    const res = await fetch('/api/credits/transfer', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ toAddress, amount })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Transfer failed');

    if (statusMsg) {
      statusMsg.innerHTML = `<span style="color:#10b981;font-weight:600;">✓ Successfully transferred ${amount} credits to ${toAddress.slice(0, 6)}...${toAddress.slice(-4)}!</span>`;
    }
    if (amtInput) amtInput.value = '';
    await loadRewardsHubData();
    await loadRewardsLedgerHistory();
  } catch (err) {
    if (statusMsg) statusMsg.innerHTML = `<span style="color:#ef4444;">${escapeHtml(err.message)}</span>`;
  }
}

// ============================================
// P2P COMPUTE MARKET CLIENT ENGINE (MODAL)
// ============================================
let p2pModalOrdersCache = [];

function switchP2PSubTab(subTab = 'buy') {
  const btnBuy = document.getElementById('p2p-subtab-buy');
  const btnSell = document.getElementById('p2p-subtab-sell');
  const btnTransfer = document.getElementById('p2p-subtab-transfer');
  const viewBuy = document.getElementById('p2p-subview-buy');
  const viewSell = document.getElementById('p2p-subview-sell');
  const viewTransfer = document.getElementById('p2p-subview-transfer');

  const resetBtn = (btn) => {
    if (!btn) return;
    btn.style.background = 'transparent';
    btn.style.borderColor = 'var(--border-subtle)';
    btn.style.color = 'var(--text-secondary)';
    btn.style.fontWeight = '600';
  };

  [btnBuy, btnSell, btnTransfer].forEach(resetBtn);
  if (viewBuy) viewBuy.style.display = 'none';
  if (viewSell) viewSell.style.display = 'none';
  if (viewTransfer) viewTransfer.style.display = 'none';

  if (subTab === 'buy') {
    if (btnBuy) {
      btnBuy.style.background = 'rgba(249,115,22,0.15)';
      btnBuy.style.borderColor = '#f97316';
      btnBuy.style.color = '#f97316';
      btnBuy.style.fontWeight = '700';
    }
    if (viewBuy) viewBuy.style.display = 'block';
    loadP2PMarketOrders();
  } else if (subTab === 'sell') {
    if (btnSell) {
      btnSell.style.background = 'rgba(249,115,22,0.15)';
      btnSell.style.borderColor = '#f97316';
      btnSell.style.color = '#f97316';
      btnSell.style.fontWeight = '700';
    }
    if (viewSell) viewSell.style.display = 'block';
    updateP2PModalAvailDisplay();
    updateP2PModalSellPreview();
  } else if (subTab === 'transfer') {
    if (btnTransfer) {
      btnTransfer.style.background = 'rgba(56,189,248,0.15)';
      btnTransfer.style.borderColor = '#38bdf8';
      btnTransfer.style.color = '#38bdf8';
      btnTransfer.style.fontWeight = '700';
    }
    if (viewTransfer) viewTransfer.style.display = 'block';
  }
}

function updateP2PModalAvailDisplay() {
  const availEl = document.getElementById('p2p-modal-avail-credits');
  const hubAvail = document.getElementById('hub-avail-credits');
  const previewSeller = document.getElementById('p2p-modal-preview-seller');

  if (availEl) {
    const rawVal = hubAvail ? hubAvail.textContent.replace(/,/g, '') : '0';
    const num = parseInt(rawVal, 10) || 0;
    availEl.textContent = `${num.toLocaleString()} Credits`;
  }
  if (previewSeller) {
    previewSeller.textContent = currentWallet
      ? `${currentWallet.slice(0, 4)}...${currentWallet.slice(-4)}`
      : 'Connect Wallet';
    previewSeller.style.color = currentWallet ? '#10b981' : '#f59e0b';
  }
}

function setP2PModalSellCredits(amt) {
  const input = document.getElementById('p2p-modal-sell-credits');
  if (!input) return;
  if (amt === 'max') {
    const hubAvail = document.getElementById('hub-avail-credits');
    const rawVal = hubAvail ? hubAvail.textContent.replace(/,/g, '') : '0';
    input.value = Math.max(100, parseInt(rawVal, 10) || 0);
  } else {
    input.value = amt;
  }
  updateP2PModalSellPreview();
}

function updateP2PModalSellPreview() {
  const creditsInput = document.getElementById('p2p-modal-sell-credits');
  const solInput = document.getElementById('p2p-modal-sell-sol');
  const ratePreview = document.getElementById('p2p-modal-preview-rate');
  const sellerPreview = document.getElementById('p2p-modal-preview-seller');

  const credits = parseFloat(creditsInput?.value || '0');
  const sol = parseFloat(solInput?.value || '0');

  if (ratePreview) {
    if (credits > 0 && sol > 0) {
      const ratePer1k = (sol / credits) * 1000;
      ratePreview.textContent = `${ratePer1k.toFixed(4)} SOL / 1k`;
    } else {
      ratePreview.textContent = '0.0000 SOL / 1k';
    }
  }

  if (sellerPreview) {
    sellerPreview.textContent = currentWallet
      ? `${currentWallet.slice(0, 4)}...${currentWallet.slice(-4)}`
      : 'Connect Wallet';
    sellerPreview.style.color = currentWallet ? '#10b981' : '#f59e0b';
  }
}

async function loadP2PMarketOrders() {
  const container = document.getElementById('p2p-modal-orders-container');
  if (!container) return;

  container.innerHTML = '<div style="text-align:center;padding:24px 0;color:var(--text-secondary);font-size:12px;">Syncing live P2P orderbook...</div>';

  try {
    const res = await fetch('/api/p2p/orders?status=ACTIVE');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch P2P orders');

    p2pModalOrdersCache = Array.isArray(data.orders) ? data.orders : [];

    if (p2pModalOrdersCache.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:32px 16px;background:var(--bg-subtle);border:1px dashed var(--border-subtle);border-radius:8px;">
          <div style="font-size:24px;margin-bottom:8px;">🔥</div>
          <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:4px;">No Active Listings Right Now</div>
          <div style="font-size:11px;color:var(--text-secondary);margin-bottom:12px;">Be the first holder to list unused compute credits for instant SOL!</div>
          <button class="btn-ghost-sm" onclick="switchP2PSubTab('sell')" style="color:#f97316;border-color:#f97316;font-weight:700;">➕ Create Listing Now</button>
        </div>
      `;
      return;
    }

    container.innerHTML = p2pModalOrdersCache.map(order => {
      const isSeller = currentWallet && order.sellerWallet && currentWallet.toLowerCase() === order.sellerWallet.toLowerCase();
      const creditsFormatted = Number(order.creditsAmount || 0).toLocaleString();
      const priceSol = Number(order.priceSol || 0);
      const ratePer1k = order.creditsAmount > 0 ? ((priceSol / order.creditsAmount) * 1000).toFixed(4) : '0.0000';
      const sellerShort = order.sellerWallet ? `${order.sellerWallet.slice(0, 4)}...${order.sellerWallet.slice(-4)}` : 'Unknown';

      return `
        <div style="background:var(--bg-subtle);border:1px solid var(--border-subtle);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;transition:border-color 0.15s ease;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="display:flex;align-items:baseline;gap:6px;">
              <span style="font-family:var(--font-mono);font-size:15px;font-weight:700;color:var(--text-primary);">${creditsFormatted}</span>
              <span style="font-size:10.5px;color:var(--text-tertiary);text-transform:uppercase;font-weight:600;">Credits</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-family:var(--font-mono);font-size:12.5px;font-weight:700;color:#10b981;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);padding:2px 8px;border-radius:4px;">
                ${priceSol} SOL
              </span>
            </div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:var(--text-secondary);border-top:1px solid rgba(255,255,255,0.05);padding-top:6px;">
            <div>
              Rate: <strong style="font-family:var(--font-mono);color:#f97316;">${ratePer1k} SOL / 1k</strong>
            </div>
            <div>
              Seller: <a href="https://solscan.io/account/${order.sellerWallet}" target="_blank" rel="noopener" style="font-family:var(--font-mono);color:var(--accent-cyan);text-decoration:none;">${sellerShort} ↗</a>
            </div>
          </div>

          <div style="display:flex;gap:6px;margin-top:2px;">
            ${isSeller ? `
              <span style="font-size:10.5px;color:var(--accent-cyan);display:flex;align-items:center;font-weight:600;">Your Listing (Escrowed)</span>
              <button class="btn-ghost-sm" onclick="cancelModalP2POrder('${order.orderId}')" style="margin-left:auto;color:#ef4444;border-color:rgba(239,68,68,0.3);padding:3px 8px;font-size:10.5px;">Cancel</button>
            ` : `
              <button class="btn-dark-primary" id="btn-buy-order-${order.orderId}" onclick="executeModalP2PBuy('${order.orderId}')" style="width:100%;background:linear-gradient(135deg, #10b981 0%, #059669 100%);color:#fff;font-weight:700;padding:6px 12px;font-size:11.5px;border:none;border-radius:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;">
                <span>⚡</span>
                <span>1-Click Buy (${priceSol} SOL)</span>
              </button>
            `}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('P2P orderbook error:', err);
    container.innerHTML = `<div style="text-align:center;padding:24px 0;color:#ef4444;font-size:11.5px;">${escapeHtml(err.message)}</div>`;
  }
}

async function submitP2PModalListing() {
  const creditsInput = document.getElementById('p2p-modal-sell-credits');
  const solInput = document.getElementById('p2p-modal-sell-sol');
  const statusEl = document.getElementById('p2p-modal-sell-status');
  const submitBtn = document.getElementById('btn-p2p-modal-submit-listing');

  if (!currentWallet) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">Please connect your Solana wallet first.</span>';
    return;
  }

  const credits = parseInt(creditsInput?.value, 10);
  const priceSol = parseFloat(solInput?.value);

  if (!credits || credits < 100) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">Minimum listing is 100 credits.</span>';
    return;
  }
  if (!priceSol || priceSol < 0.001) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">Minimum asking price is 0.001 SOL.</span>';
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Escrowing Credits & Creating Listing...';
  }
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-secondary);">Creating order on ledger...</span>';

  try {
    const res = await fetch('/api/p2p/orders/create', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        sellerWallet: currentWallet,
        creditsAmount: credits,
        priceSol: priceSol
      })
    });

    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to create listing');

    if (statusEl) {
      statusEl.innerHTML = `<span style="color:#10b981;font-weight:700;">✓ Listing Created! ${credits.toLocaleString()} credits escrowed.</span>`;
    }
    await loadRewardsHubData();
    await loadRewardsLedgerHistory();
    setTimeout(() => {
      switchP2PSubTab('buy');
    }, 1200);
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">${escapeHtml(err.message)}</span>`;
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '🔥 Create Listing &amp; Escrow Credits';
    }
  }
}

async function cancelModalP2POrder(orderId) {
  if (!confirm('Are you sure you want to cancel this listing and release your escrowed credits?')) return;

  try {
    const res = await fetch('/api/p2p/orders/cancel', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        orderId,
        sellerWallet: currentWallet
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Failed to cancel order');

    await loadRewardsHubData();
    await loadRewardsLedgerHistory();
    await loadP2PMarketOrders();
  } catch (err) {
    alert(`Cancellation error: ${err.message}`);
  }
}

async function executeModalP2PBuy(orderId) {
  const order = p2pModalOrdersCache.find(o => o.orderId === orderId);
  if (!order) {
    alert('Order details not found. Refreshing orderbook...');
    loadP2PMarketOrders();
    return;
  }

  const provider = window.solana || window.phantom?.solana;
  if (!provider) {
    alert('Phantom wallet extension is required for 1-click purchase.');
    window.open('https://phantom.app', '_blank');
    return;
  }

  if (!currentWallet) {
    try {
      const resp = await provider.connect();
      currentWallet = resp.publicKey.toString();
      await loadRewardsHubData();
    } catch (e) {
      alert('Wallet connection cancelled.');
      return;
    }
  }

  if (currentWallet.toLowerCase() === order.sellerWallet.toLowerCase()) {
    alert('You cannot purchase your own order.');
    return;
  }

  const buyBtn = document.getElementById(`btn-buy-order-${orderId}`);
  if (buyBtn) {
    buyBtn.disabled = true;
    buyBtn.textContent = 'Building Solana transaction...';
  }

  try {
    if (!window.solanaWeb3) {
      throw new Error('Solana Web3 runtime not ready. Please refresh the page.');
    }

    const buyerPubkey = new window.solanaWeb3.PublicKey(currentWallet);
    const sellerPubkey = new window.solanaWeb3.PublicKey(order.sellerWallet);
    const tx = new window.solanaWeb3.Transaction();
    tx.feePayer = buyerPubkey;

    // Native SOL transfer directly to seller wallet
    const lamports = BigInt(order.priceLamports);
    tx.add(window.solanaWeb3.SystemProgram.transfer({
      fromPubkey: buyerPubkey,
      toPubkey: sellerPubkey,
      lamports: lamports
    }));

    if (buyBtn) buyBtn.textContent = 'Fetching network blockhash...';
    const bhRes = await fetch('/api/solana/latest-blockhash');
    const bhData = await bhRes.json();
    if (!bhData.success || !bhData.blockhash) {
      throw new Error('Unable to retrieve recent blockhash from Solana RPC');
    }
    tx.recentBlockhash = bhData.blockhash;

    if (buyBtn) buyBtn.textContent = 'Approve in Phantom...';
    const sendResult = await provider.signAndSendTransaction(tx);
    let txSig = typeof sendResult === 'string' ? sendResult : (sendResult?.signature || sendResult);
    if (txSig instanceof Uint8Array || Array.isArray(txSig)) {
      txSig = new window.solanaWeb3.PublicKey(txSig).toBase58();
    }

    if (!txSig) throw new Error('Transaction was signed but signature was not returned by Phantom.');

    if (buyBtn) buyBtn.textContent = 'Verifying on-chain settlement...';

    // Poll fulfillment endpoint
    let fulfilled = false;
    let lastErr = '';
    for (let attempt = 1; attempt <= 7; attempt++) {
      try {
        if (buyBtn) buyBtn.textContent = `Verifying on-chain (${attempt}/7)...`;
        await new Promise(r => setTimeout(r, 3500));

        const fRes = await fetch('/api/p2p/orders/fulfill', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            orderId: order.orderId,
            buyerWallet: currentWallet,
            txSignature: txSig
          })
        });

        const fData = await fRes.json();
        if (fRes.ok && fData.success) {
          fulfilled = true;
          alert(`🎉 Purchase Confirmed! ${order.creditsAmount.toLocaleString()} credits have been delivered to your balance.`);
          await loadRewardsHubData();
          await loadRewardsLedgerHistory();
          await loadP2PMarketOrders();
          break;
        } else {
          lastErr = fData.error || 'Pending on-chain confirmation...';
        }
      } catch (e) {
        lastErr = e.message;
      }
    }

    if (!fulfilled) {
      alert(`Transaction broadcasted (${txSig.slice(0, 8)}...), but pending final confirmation: ${lastErr}. You can verify again in Burning Day terminal.`);
    }
  } catch (err) {
    console.error('1-Click P2P Buy error:', err);
    alert(`Purchase error: ${err.message}`);
  } finally {
    if (buyBtn) {
      buyBtn.disabled = false;
      buyBtn.innerHTML = `<span>⚡</span><span>1-Click Buy (${order.priceSol} SOL)</span>`;
    }
  }
}

let burnQuoteDebounce = null;
async function updateRedeemPreview() {
  const amtInput = document.getElementById('redeem-credit-input');
  const payoutEl = document.getElementById('redeem-preview-payout');
  const rateEl = document.getElementById('redeem-preview-rate');

  let amt = parseInt(amtInput?.value, 10) || 0;
  if (amt <= 0) amt = 10;

  clearTimeout(burnQuoteDebounce);
  burnQuoteDebounce = setTimeout(async () => {
    try {
      const res = await fetch(`/api/credits/burn-quote?credits=${amt}`);
      if (res.ok) {
        const quote = await res.json();
        if (payoutEl) {
          payoutEl.textContent = `${Number(quote.estimatedRewardSol || 0).toFixed(6)} SOL`;
        }
        if (rateEl) {
          rateEl.textContent = `1 credit = ~${((quote.rateLamportsPerCredit || 0) / 1e9).toFixed(8)} SOL (MC: $${Number(quote.marketCapUsd || 0).toLocaleString()})`;
        }
      }
    } catch (e) {
      console.warn('Burn quote fetch error:', e);
    }
  }, 150);
}

async function submitRedemptionClaim() {
  const amtInput = document.getElementById('redeem-credit-input');
  const statusMsg = document.getElementById('redeem-status-msg');
  const submitBtn = document.getElementById('btn-submit-redeem');
  const amount = parseInt(amtInput?.value, 10);

  if (!amount || amount < 10) {
    if (statusMsg) statusMsg.innerHTML = '<span style="color:#ef4444;">Minimum burn is 10 credits.</span>';
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Processing On-Chain Payout...';
  }
  if (statusMsg) statusMsg.innerHTML = '<span style="color:var(--text-secondary);">Broadcasting on-chain credit burn &amp; SOL reward payout...</span>';

  const idempotencyKey = crypto.randomUUID ? crypto.randomUUID() : `idemp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  try {
    const res = await fetch('/api/credits/burn', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ credits: amount, idempotencyKey })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Burn request failed');

    const txSig = data.txSignature ? `${data.txSignature.slice(0, 8)}...${data.txSignature.slice(-6)}` : 'Confirmed';
    const solscanUrl = data.txSignature ? `https://solscan.io/tx/${data.txSignature}` : '#';

    if (statusMsg) {
      statusMsg.innerHTML = `<div style="color:#10b981;font-weight:600;margin-bottom:4px;">🔥 Burn Confirmed! Received +${data.rewardSol} SOL</div>
      <div style="font-size:10.5px;color:var(--text-secondary);">
        Solana Tx: <a href="${solscanUrl}" target="_blank" rel="noopener" style="color:var(--accent-cyan);text-decoration:underline;">${escapeHtml(txSig)}</a><br/>
        Remaining Available Credits: <strong>${Number(data.remainingCredits || 0).toLocaleString()}</strong>
      </div>`;
    }
    await loadRewardsHubData();
    await loadRewardsLedgerHistory();
  } catch (err) {
    if (statusMsg) statusMsg.innerHTML = `<span style="color:#ef4444;">${escapeHtml(err.message)}</span>`;
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '🔥 Burn Credits & Claim SOL Reward';
    }
  }
}

async function loadRewardsLedgerHistory() {
  const tbody = document.getElementById('rewards-ledger-tbody');
  if (!tbody) return;

  try {
    const histUrl = currentWallet ? `/api/credits/history?address=${encodeURIComponent(currentWallet)}` : '/api/credits/history';
    const res = await fetch(histUrl, { headers: authHeaders() });
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-tertiary);padding:14px;">Connect wallet to view ledger history</td></tr>';
      return;
    }
    const data = await res.json();
    const ledger = Array.isArray(data.ledger) ? data.ledger : [];

    if (ledger.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-tertiary);padding:14px;">No transactions recorded yet</td></tr>';
      return;
    }

    tbody.innerHTML = ledger.slice(-50).reverse().map(entry => {
      const typeLower = (entry.type || '').toLowerCase();
      let badgeClass = 'badge-tag-accrual';
      if (typeLower.includes('usage')) badgeClass = 'badge-tag-usage';
      else if (typeLower.includes('transfer')) badgeClass = 'badge-tag-transfer';
      else if (typeLower.includes('redeem')) badgeClass = 'badge-tag-redeem';

      const timeStr = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
      const deltaStr = entry.delta > 0 ? `+${entry.delta}` : `${entry.delta}`;
      const deltaColor = entry.delta > 0 ? '#10b981' : '#ef4444';

      let refLink = escapeHtml(entry.reference || entry.reason || '-');
      if (entry.metadata?.solanaSignature) {
        const sig = entry.metadata.solanaSignature;
        refLink = `<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener" style="color:var(--accent-cyan);text-decoration:none;">Solscan ↗</a>`;
      } else if (entry.metadata?.claimId) {
        refLink = `<span style="font-family:var(--font-mono);font-size:10px;">${escapeHtml(entry.metadata.claimId)}</span>`;
      }

      return `<tr>
        <td style="font-family:var(--font-mono);font-size:10px;color:var(--text-tertiary);">${timeStr}</td>
        <td><span class="badge-tag ${badgeClass}">${escapeHtml(entry.type)}</span></td>
        <td style="font-family:var(--font-mono);font-weight:600;color:${deltaColor};">${deltaStr}</td>
        <td style="font-family:var(--font-mono);">${entry.balance}</td>
        <td style="color:var(--text-secondary);font-size:10px;">${refLink}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    console.warn('Ledger load error:', err);
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:14px;">Error loading ledger history</td></tr>';
  }
}

async function loadOperatorClaims() {
  const container = document.getElementById('operator-claims-list');
  const secret = document.getElementById('operator-secret-input')?.value.trim() || '';
  if (!container) return;

  try {
    const headers = { ...authHeaders() };
    if (secret) headers['x-operator-key'] = secret;
    const res = await fetch('/api/operator/claims', { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch operator claims');

    const pending = Array.isArray(data.pendingClaims) ? data.pendingClaims : [];
    if (pending.length === 0) {
      container.innerHTML = '<div style="color:#10b981;text-align:center;padding:6px;">✓ All manual reward transfers are fulfilled! No pending claims.</div>';
      return;
    }

    container.innerHTML = pending.map(c => {
      const addr = c.destinationWallet || c.walletAddress || c.userAddress || 'Unknown';
      const payoutSol = c.manualAllocation?.sol ?? c.operatorPayoutSOL ?? c.manualSol ?? 0;
      return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 6px;border-bottom:1px solid var(--border-subtle);cursor:pointer;" onclick="document.getElementById('operator-claim-id-input').value='${c.claimId}'">
        <div>
          <span style="font-family:var(--font-mono);font-weight:600;color:var(--text-primary);">${escapeHtml(c.claimId)}</span>
          <div style="font-size:9.5px;color:var(--text-tertiary);font-family:var(--font-mono);">${addr.slice(0, 6)}...${addr.slice(-4)}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-family:var(--font-mono);color:#10b981;font-weight:600;">${Number(payoutSol).toFixed(4)} SOL</div>
          <span class="badge-tag badge-tag-pending">${c.status}</span>
        </div>
      </div>
    `;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div style="color:#ef4444;text-align:center;padding:6px;">${escapeHtml(err.message)}</div>`;
  }
}

async function confirmOperatorTransfer() {
  const claimId = document.getElementById('operator-claim-id-input')?.value.trim();
  const solanaSignature = document.getElementById('operator-sig-input')?.value.trim();
  const secret = document.getElementById('operator-secret-input')?.value.trim();
  const statusMsg = document.getElementById('operator-status-msg');

  if (!claimId || !solanaSignature) {
    if (statusMsg) statusMsg.innerHTML = '<span style="color:#ef4444;">Claim ID and Solana signature are required.</span>';
    return;
  }

  if (statusMsg) statusMsg.textContent = 'Verifying Base58 signature and confirming on-chain...';

  try {
    const headers = { 'Content-Type': 'application/json', ...authHeaders() };
    if (secret) headers['x-operator-key'] = secret;
    const res = await fetch('/api/operator/confirm-transfer', {
      method: 'POST',
      headers,
      body: JSON.stringify({ claimId, solanaSignature })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Confirmation failed');

    if (statusMsg) {
      statusMsg.innerHTML = `<span style="color:#10b981;font-weight:600;">✓ Confirmed! Claim ${escapeHtml(claimId)} marked fulfilled on-chain.</span>`;
    }
    const sigInput = document.getElementById('operator-sig-input');
    if (sigInput) sigInput.value = '';
    await loadOperatorClaims();
    await loadRewardsHubData();
    await loadRewardsLedgerHistory();
  } catch (err) {
    if (statusMsg) statusMsg.innerHTML = `<span style="color:#ef4444;">${escapeHtml(err.message)}</span>`;
  }
}

// ============================================
// JEV BRAIN CLI & API KEY MANAGEMENT
// ============================================
let latestGeneratedCliKey = '';
let activeCliKeyId = null;

async function loadCliKeyData() {
  const badge = document.getElementById('cli-holder-badge');
  const warning = document.getElementById('cli-gate-warning');
  const keySection = document.getElementById('cli-key-section');
  const activeBox = document.getElementById('cli-active-key-box');
  const noKeyBox = document.getElementById('cli-no-key-box');
  const keyInput = document.getElementById('cli-key-input');
  const keyMeta = document.getElementById('cli-key-meta');
  const btnGenNew = document.getElementById('btn-generate-cli-key');
  const btnToggle = document.getElementById('btn-toggle-cli-key');
  const step1Cmd = document.getElementById('cli-step1-cmd');

  if (!currentWallet) {
    if (badge) badge.textContent = 'Disconnected';
    if (warning) {
      warning.style.display = 'block';
      warning.innerHTML = '<strong>Wallet Required:</strong> Connect your Solana wallet holding $JEVBRAIN tokens to generate your CLI API key.';
    }
    if (keySection) keySection.style.display = 'none';
    return;
  }

  // Check token holding / tier
  const isHolder = currentTier && currentTier.tierId > 0;
  if (!isHolder) {
    if (badge) badge.textContent = 'Non-Holder (0 $JEVBRAIN)';
    if (warning) {
      warning.style.display = 'block';
      warning.innerHTML = '<strong>Token Holding Required:</strong> Your connected wallet (' + escapeHtml(currentWallet.slice(0, 4) + '...' + currentWallet.slice(-4)) + ') does not hold the minimum required $JEVBRAIN tokens. Acquire tokens to unlock local CLI access.';
    }
    if (keySection) keySection.style.display = 'none';
    return;
  }

  if (warning) warning.style.display = 'none';
  if (keySection) keySection.style.display = 'block';
  if (badge) badge.textContent = `✔ ${currentTier.tierName || 'Verified Holder'}`;

  const token = getSessionToken();
  if (!token) return;

  try {
    const res = await fetch('/api/keys', { headers: authHeaders() });
    const data = await res.json();
    if (data.success && data.keys && data.keys.length > 0) {
      const activeKey = data.keys.find(k => !k.isRevoked) || data.keys[0];
      if (activeKey && !activeKey.isRevoked) {
        activeCliKeyId = activeKey.keyId;
        if (activeBox) activeBox.style.display = 'block';
        if (noKeyBox) noKeyBox.style.display = 'none';
        if (btnGenNew) btnGenNew.style.display = 'inline-block';

        if (latestGeneratedCliKey && latestGeneratedCliKey.startsWith('jev_live_')) {
          if (keyInput) {
            keyInput.value = latestGeneratedCliKey;
            keyInput.type = 'text';
          }
          if (btnToggle) btnToggle.textContent = 'Hide';
          if (step1Cmd) step1Cmd.textContent = `jevbrain config set-key ${latestGeneratedCliKey}`;
        } else {
          if (keyInput) {
            keyInput.value = activeKey.maskedKey;
            keyInput.type = 'text';
          }
          if (btnToggle) btnToggle.textContent = 'Masked';
          if (step1Cmd) step1Cmd.textContent = `jevbrain config set-key ${activeKey.maskedKey}`;
        }

        const statusPill = document.getElementById('cli-key-status-pill');
        const suspendedNotice = document.getElementById('cli-suspended-notice');
        const isSuspended = activeKey.status === 'suspended';

        if (statusPill) {
          if (isSuspended) {
            statusPill.textContent = 'SUSPENDED (NO TOKENS)';
            statusPill.style.background = 'rgba(239, 68, 68, 0.2)';
            statusPill.style.color = '#ef4444';
          } else {
            statusPill.textContent = 'ACTIVE';
            statusPill.style.background = 'rgba(16, 185, 129, 0.2)';
            statusPill.style.color = '#10b981';
          }
        }

        if (suspendedNotice) {
          suspendedNotice.style.display = isSuspended ? 'block' : 'none';
        }

        if (keyMeta) {
          const createdDate = new Date(activeKey.createdAt).toLocaleDateString();
          const usedDate = activeKey.lastUsedAt ? new Date(activeKey.lastUsedAt).toLocaleDateString() : 'Never';
          let expInfo = '';
          if (activeKey.expiresAt) {
            const expDate = new Date(activeKey.expiresAt);
            expInfo = ` · Expires: ${expDate.toLocaleDateString()}`;
          }
          keyMeta.textContent = `Created: ${createdDate}${expInfo} · Used: ${usedDate}`;
        }
        return;
      }
    }

    // No active key found
    activeCliKeyId = null;
    latestGeneratedCliKey = '';
    if (activeBox) activeBox.style.display = 'none';
    if (noKeyBox) noKeyBox.style.display = 'block';
    if (btnGenNew) btnGenNew.style.display = 'none';
    if (step1Cmd) step1Cmd.textContent = 'jevbrain config set-key <your-key>';
  } catch (err) {
    console.warn('[CLI] Error fetching keys:', err.message);
  }
}

async function generateCliApiKey() {
  const token = getSessionToken();
  if (!token) {
    alert('Please connect your Solana wallet first.');
    return;
  }

  const btnFirst = document.getElementById('btn-generate-first-cli-key');
  const btnNew = document.getElementById('btn-generate-cli-key');
  const nameInput = document.getElementById('cli-key-name-input');
  const expirySelect = document.getElementById('cli-key-expiry-select');

  if (btnFirst) btnFirst.disabled = true;
  if (btnNew) btnNew.disabled = true;

  const name = nameInput?.value?.trim() || 'Web Dashboard Key';
  const expiry = expirySelect?.value || '30d';

  try {
    const res = await fetch('/api/keys/generate', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name, expiry })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate API key');

    latestGeneratedCliKey = data.key.apiKey;
    activeCliKeyId = data.key.keyId;

    await loadCliKeyData();

    try {
      await navigator.clipboard.writeText(latestGeneratedCliKey);
      alert('⚡ Jev Brain API key generated and copied to clipboard!\n\nRun in your terminal:\nnpx jevbrain config set-key ' + latestGeneratedCliKey);
    } catch {
      alert('⚡ Jev Brain API key generated!\n\nPlease copy your key from the box to configure your terminal.');
    }
  } catch (err) {
    alert(`Could not generate API key: ${err.message}`);
  } finally {
    if (btnFirst) btnFirst.disabled = false;
    if (btnNew) btnNew.disabled = false;
  }
}

async function revokeCliApiKey() {
  if (!activeCliKeyId) return;
  const ok = confirm('Are you sure you want to revoke this Jev Brain CLI API key? Any terminal or local agents using this key will immediately lose access.');
  if (!ok) return;

  try {
    const res = await fetch('/api/keys/revoke', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ keyId: activeCliKeyId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Revoke failed');

    latestGeneratedCliKey = '';
    activeCliKeyId = null;
    await loadCliKeyData();
    alert('✔ CLI API key revoked successfully.');
  } catch (err) {
    alert(`Could not revoke key: ${err.message}`);
  }
}

async function deleteCliApiKey() {
  if (!activeCliKeyId) return;
  const ok = confirm('Are you sure you want to permanently delete this Jev Brain API key from the database? This action cannot be undone.');
  if (!ok) return;

  try {
    const res = await fetch('/api/keys/delete', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ keyId: activeCliKeyId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');

    latestGeneratedCliKey = '';
    activeCliKeyId = null;
    await loadCliKeyData();
    alert('✔ API key permanently deleted from database.');
  } catch (err) {
    alert(`Could not delete key: ${err.message}`);
  }
}

function toggleCliKeyVisibility() {
  const keyInput = document.getElementById('cli-key-input');
  const btnToggle = document.getElementById('btn-toggle-cli-key');
  if (!keyInput || !btnToggle) return;

  if (keyInput.type === 'password') {
    keyInput.type = 'text';
    btnToggle.textContent = 'Hide';
  } else {
    keyInput.type = 'password';
    btnToggle.textContent = 'Show';
  }
}

function copyCliApiKey() {
  const keyToCopy = latestGeneratedCliKey || document.getElementById('cli-key-input')?.value || '';
  if (!keyToCopy) return;

  navigator.clipboard.writeText(keyToCopy);
  const copyBtn = document.getElementById('btn-copy-cli-key');
  if (copyBtn) {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { if (copyBtn) copyBtn.textContent = 'Copy'; }, 1500);
  }
}

// ============================================
// BURN-TO-BOOST (2.0x LIFETIME MULTIPLIER)
// ============================================

async function loadBoostStatus() {
  const statusPill = document.getElementById('boost-status-pill');
  const userTierEl = document.getElementById('boost-user-tier');
  const reqEl = document.getElementById('boost-tokens-required');
  const projEl = document.getElementById('boost-projected-rate');
  const receiptsTbody = document.getElementById('boost-receipts-tbody');
  const actionStatus = document.getElementById('boost-action-status');

  if (!currentWallet) {
    if (actionStatus) actionStatus.innerHTML = '<span style="color:#ef4444;">Please connect your Solana wallet first.</span>';
    return;
  }

  try {
    const res = await fetch(`/api/boost/status?wallet=${encodeURIComponent(currentWallet)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error('Failed to fetch boost status');
    const data = await res.json();

    const mult = Number(data.boostMultiplier || 1.0);
    const isBoosted = mult > 1.0;

    if (statusPill) {
      if (isBoosted) {
        statusPill.style.background = 'rgba(16, 185, 129, 0.15)';
        statusPill.style.color = '#10b981';
        statusPill.textContent = `⚡ ${mult.toFixed(1)}x Titan Boost (Active)`;
      } else {
        statusPill.style.background = 'rgba(56, 189, 248, 0.15)';
        statusPill.style.color = '#38bdf8';
        statusPill.textContent = '1.0x Base Rate (Unboosted)';
      }
    }

    if (actionStatus) {
      if (isBoosted) {
        actionStatus.innerHTML = '<div style="background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.3);border-radius:6px;padding:8px 12px;color:#10b981;font-size:11.5px;text-align:left;"><strong>🎉 2.0x Active:</strong> You are receiving 2.0x credit accrual on the basis of your verified token burn supply.</div>';
      } else {
        actionStatus.innerHTML = '<div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:6px;padding:8px 12px;color:#f59e0b;font-size:11.5px;text-align:left;"><strong>⚠️ Notice:</strong> You are not getting 2x on the basis of your burn supply. Burn your required tier quota above to activate 2.0x lifetime rewards.</div>';
      }
    }

    if (data.requirement) {
      if (userTierEl) userTierEl.textContent = `${data.requirement.tierName} (Tier ${data.requirement.tierLevel})`;
      if (reqEl) reqEl.textContent = `${Number(data.requirement.requiredTokensUi).toLocaleString()} $JEVBRAIN`;
      if (projEl) {
        const per15m = data.requirement.boostedRatePer15Min || Math.round((data.requirement.boostedRatePerHour || 0) / 4);
        projEl.textContent = `${per15m.toLocaleString()} / 15m (${Number(data.requirement.boostedRatePerHour).toLocaleString()}/hr · ${Number(data.requirement.boostedCreditsPerDay).toLocaleString()}/day)`;
      }
    } else {
      if (userTierEl) userTierEl.textContent = 'Tier 0 (Holdings Required)';
      if (reqEl) reqEl.textContent = 'Hold $JEVBRAIN tokens to qualify';
      if (projEl) projEl.textContent = '--';
    }

    // Render receipts
    if (receiptsTbody) {
      const receipts = data.receipts || [];
      if (receipts.length === 0) {
        receiptsTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-tertiary);padding:10px;">No on-chain burns recorded yet</td></tr>';
      } else {
        receiptsTbody.innerHTML = receipts.map(r => {
          const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : 'Recent';
          const sigShort = r.txSignature ? `${r.txSignature.slice(0, 8)}...${r.txSignature.slice(-6)}` : 'On-chain';
          const sigUrl = r.txSignature ? `https://solscan.io/tx/${r.txSignature}` : '#';
          return `
            <tr>
              <td>${date}</td>
              <td style="font-weight:600;color:#10b981;">${Number(r.tokensBurnedUi || 0).toLocaleString()}</td>
              <td><strong>${r.multiplierAwarded}x</strong></td>
              <td><a href="${sigUrl}" target="_blank" rel="noopener" style="color:var(--accent-cyan);text-decoration:none;font-family:var(--font-mono);">${sigShort} ↗</a></td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.warn('Boost status load error:', err);
  }
}

async function handleBoostVerification() {
  const input = document.getElementById('boost-tx-input');
  const btn = document.getElementById('btn-verify-boost');
  const statusEl = document.getElementById('boost-action-status');

  const sig = input?.value?.trim();
  if (!sig) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">Please paste your Solana transaction signature.</span>';
    return;
  }

  if (btn) btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent-cyan);">Verifying on-chain transaction via Solana RPC...</span>';

  try {
    const res = await fetch('/api/boost/burn-verify', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ txSignature: sig, walletAddress: currentWallet })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Verification failed');
    }

    if (statusEl) {
      statusEl.innerHTML = `<span style="color:#10b981;font-weight:600;">🎉 Success! Verified burn of ${data.tokensBurned} $JEVBRAIN. ${data.boostMultiplier}x Lifetime Multiplier is now permanently active!</span>`;
    }
    if (input) input.value = '';
    showNotification(`⚡ ${data.boostMultiplier}x Lifetime Multiplier Unlocked!`, 'success');
    await loadBoostStatus();
    await loadRewardsHubData();
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">Verification error: ${escapeHtml(err.message)}</span>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function handleAttachment(file) {
  if (!file) return;
  const maxBytes = 1024 * 1024;
  if (file.size > maxBytes) {
    alert('Attachment is too large. Please choose a file under 1 MB.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingAttachment = { name: file.name, text: String(reader.result || '') };
    if (elements.attachmentChip) {
      elements.attachmentChip.hidden = false;
      elements.attachmentChip.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
        </svg>
        <span>${escapeHtml(file.name)}</span>
        <span style="opacity:0.6;margin-left:3px;">&times;</span>
      `;
    }
  };
  reader.onerror = () => alert('Could not read this attachment.');
  reader.readAsText(file);
}

function toggleVoiceDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert('Voice dictation is not supported in this browser. Try Chrome or Edge.');
    return;
  }
  if (speechRecognition) {
    speechRecognition.stop();
    speechRecognition = null;
    elements.voiceBtn?.classList.remove('recording');
    return;
  }
  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = navigator.language || 'en-US';
  speechRecognition.onresult = event => {
    const transcript = [...event.results].map(result => result[0].transcript).join('');
    elements.input.value = transcript;
    elements.input.dispatchEvent(new Event('input'));
  };
  speechRecognition.onerror = event => {
    if (event.error !== 'aborted') alert(`Voice dictation failed: ${event.error}`);
    speechRecognition = null;
    elements.voiceBtn?.classList.remove('recording');
  };
  speechRecognition.onend = () => {
    speechRecognition = null;
    elements.voiceBtn?.classList.remove('recording');
  };
  speechRecognition.start();
  elements.voiceBtn?.classList.add('recording');
}

async function toggleAudioRecording() {
  if (audioRecorder?.state === 'recording') {
    audioRecorder.stop();
    elements.audioBtn?.classList.remove('recording');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    alert('Audio recording is not supported in this browser.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    audioRecorder = new MediaRecorder(stream);
    audioRecorder.ondataavailable = event => { if (event.data.size) audioChunks.push(event.data); };
    audioRecorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(audioChunks, { type: audioRecorder.mimeType || 'audio/webm' });
      pendingAttachment = { name: `voice-note-${Date.now()}.webm`, blob, text: '[Voice recording attached]' };
      if (elements.attachmentChip) {
        elements.attachmentChip.hidden = false;
        elements.attachmentChip.innerHTML = `
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
            <line x1="12" y1="19" x2="12" y2="23"></line>
            <line x1="8" y1="23" x2="16" y2="23"></line>
          </svg>
          <span>Voice note attached</span>
          <span style="opacity:0.6;margin-left:3px;">&times;</span>
        `;
      }
      elements.audioBtn?.classList.remove('recording');
    };
    audioRecorder.start();
    elements.audioBtn?.classList.add('recording');
  } catch (err) {
    alert(`Microphone permission was not granted: ${err.message}`);
  }
}

// ============================================
// SEARCH & TRANSCRIPT EXPORT
// ============================================
function openSearchModal() {
  elements.searchModal.style.display = 'flex';
  elements.chatSearchInput.focus();
}

function handleSearchMessages() {
  const query = elements.chatSearchInput.value.trim().toLowerCase();
  if (!query) {
    elements.chatSearchResults.innerHTML = 'Type above to search messages across all sessions.';
    return;
  }

  const chats = getSavedChats();
  let matches = [];

  chats.forEach(c => {
    c.messages.forEach(m => {
      if (m.content && m.content.toLowerCase().includes(query)) {
        matches.push({ chatTitle: c.title, chatId: c.id, content: m.content, role: m.role });
      }
    });
  });

  if (matches.length === 0) {
    elements.chatSearchResults.innerHTML = '<div style="color:var(--text-muted);">No matching messages found.</div>';
    return;
  }

  elements.chatSearchResults.innerHTML = matches.map(m => `
    <div style="padding:6px;border-bottom:1px solid var(--border-light);cursor:pointer;" onclick="switchFromSearch('${m.chatId}')">
      <span style="font-weight:600;font-size:11px;color:var(--accent-terracotta);">${escapeHtml(m.chatTitle)}</span>
      <div style="font-size:11.5px;">${escapeHtml(m.content.slice(0, 100))}...</div>
    </div>
  `).join('');
}

window.switchFromSearch = function(chatId) {
  elements.searchModal.style.display = 'none';
  setActiveChatId(chatId);
  renderChatsList();
  loadChatMessages(chatId);
};

function exportCurrentChat(format = 'json') {
  const chats = getSavedChats();
  const chat = chats.find(c => c.id === currentChatId);
  if (!chat) return;

  let blob;
  let filename = `${chat.title.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

  if (format === 'json') {
    blob = new Blob([JSON.stringify(chat, null, 2)], { type: 'application/json' });
    filename += '.json';
  } else {
    let md = `# ${chat.title}\n\nDate: ${new Date(chat.createdAt).toLocaleString()}\n\n`;
    chat.messages.forEach(m => {
      md += `### ${m.role === 'user' ? 'User' : 'Jev Brain (' + (m.modelName || 'Router') + ')'}\n\n${m.content}\n\n---\n\n`;
    });
    blob = new Blob([md], { type: 'text/markdown' });
    filename += '.md';
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================
// DYNAMIC TIER MODAL (DEXSCREENER SYNCED)
// ============================================
const TOKEN_CA = 'AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump';

function copyCA() {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(TOKEN_CA).then(showCopiedFeedback).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

function fallbackCopy() {
  try {
    const tempInput = document.createElement('input');
    tempInput.value = TOKEN_CA;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    document.body.removeChild(tempInput);
    showCopiedFeedback();
  } catch (e) {
    prompt('Copy Token Contract Address (CA):', TOKEN_CA);
  }
}

function showCopiedFeedback() {
  const targets = [
    document.getElementById('copy-ca-btn'),
    document.getElementById('hero-copy-ca'),
    document.getElementById('strip-copy-ca-btn')
  ];
  targets.forEach(btn => {
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = 'Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }
  });
}

async function loadMarketInfo() {
  try {
    const res = await fetch('/api/market-info');
    if (res.ok) {
      const data = await res.json();
      const m = data.marketData || {};
      const mc = m.marketCap || 100000;
      const price = m.priceUsd || 0.0001;
      const vol = m.volume24h || 0;
      const liq = m.liquidityUsd || 0;

      const formatUsd = (num) => {
        if (!num || isNaN(num)) return '$0';
        if (num >= 1000000) return `$${(num / 1000000).toFixed(2)}M`;
        if (num >= 1000) return `$${(num / 1000).toFixed(1)}K`;
        return `$${Number(num).toFixed(2)}`;
      };

      const formatPrice = (p) => {
        if (!p || isNaN(p)) return '$0.00';
        if (p < 0.0001) return `$${Number(p).toFixed(7)}`;
        if (p < 0.01) return `$${Number(p).toFixed(5)}`;
        return `$${Number(p).toFixed(4)}`;
      };

      // Topbar MC display
      if (elements.mc) elements.mc.textContent = formatUsd(mc);

      // Hero Token Widget updates
      const heroMc = document.getElementById('hero-mc');
      const heroPrice = document.getElementById('hero-price');
      const heroVol = document.getElementById('hero-vol');
      const heroLiq = document.getElementById('hero-liq');

      if (heroMc) heroMc.textContent = formatUsd(mc);
      if (heroPrice) heroPrice.textContent = formatPrice(price);
      if (heroVol) heroVol.textContent = formatUsd(vol);
      if (heroLiq) heroLiq.textContent = formatUsd(liq);

      renderTierModalTable(data);
    }
  } catch (e) {
    console.warn('Market info fetch failed:', e);
  }
}

function renderTierModalTable(data) {
  const modalMc = document.getElementById('modal-mc');
  const modalPrice = document.getElementById('modal-price');
  const modalTrust = document.getElementById('modal-trust');
  const container = document.getElementById('tier-table-container');
  if (!container) return;

  const mc = data?.marketData?.marketCap || 100000;
  const price = data?.marketData?.priceUsd || (mc / 1000000000);
  const trust = data?.trustFactor || Math.max(1.0, Math.sqrt(mc / 100000));

  if (modalMc) modalMc.textContent = mc >= 1000000 ? `$${(mc / 1000000).toFixed(2)}M` : `$${(mc / 1000).toFixed(1)}K`;
  if (modalPrice) modalPrice.textContent = `$${price.toFixed(6)}`;
  if (modalTrust) modalTrust.textContent = `${trust.toFixed(2)}x`;

  const tiers = data?.dynamicTiers || [];
  let html = `
    <table>
      <thead>
        <tr>
          <th>Tier</th>
          <th>Min Bag ($)</th>
          <th>Tokens Needed</th>
          <th>Multiplier</th>
          <th>Unlocked AI Models</th>
        </tr>
      </thead>
      <tbody>
  `;

  tiers.forEach(t => {
    const isActive = userTier?.tierName === t.name;
    const activeClass = isActive ? 'tier-row-active' : '';
    html += `
      <tr class="${activeClass}">
        <td class="tier-badge-cell">${isActive ? '● ' : ''}${t.name}</td>
        <td><strong>$${t.requiredUsd.toLocaleString()}</strong></td>
        <td>${t.requiredTokens.toLocaleString()}</td>
        <td>${t.weight}x (${t.cutPct}% Cut)</td>
        <td style="font-size:11px;color:var(--text-secondary);">${t.description}</td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

// ============================================
// MARKDOWN & STRING FORMATTING
// ============================================
function formatMarkdown(text) {
  if (!text) return '';
  let content = escapeHtml(text);
  content = content.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const langLabel = lang || 'code';
    return `<div class="code-block-wrapper" style="margin:8px 0;background:var(--bg-subtle);border:1px solid var(--border-subtle);border-radius:6px;overflow:hidden;">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.02);border-bottom:1px solid var(--border-subtle);font-size:10px;font-family:var(--font-mono);color:var(--text-tertiary);">
        <span>${langLabel}</span>
        <button onclick="navigator.clipboard.writeText(this.closest('.code-block-wrapper').querySelector('code').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1600)})" style="background:transparent;border:none;color:var(--text-secondary);cursor:pointer;font-size:10.5px;padding:2px 4px;">Copy</button>
      </div>
      <pre style="padding:8px 10px;margin:0;overflow-x:auto;font-family:var(--font-mono);font-size:12px;line-height:1.45;"><code>${code}</code></pre>
    </div>`;
  });
  content = content.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  content = content.replace(/\*(.*?)\*/g, '<i>$1</i>');
  content = content.replace(/`([^`]+)`/g, '<code style="background:var(--bg-subtle);padding:2px 5px;border-radius:4px;font-family:var(--font-mono);font-size:12px;">$1</code>');
  content = content.replace(/\n/g, '<br>');
  return content;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================
// ATTACH EVENT LISTENERS
// ============================================

// ============================================
// MOBILE RUNNER (ANDROID DEVICE GATEWAY)
// ============================================
let mobilePollInterval = null;

async function openMobileModal() {
  const modal = document.getElementById('mobile-modal');
  if (modal) modal.style.display = 'flex';
  await refreshMobileDevices();
  await refreshMobileLogs();
  if (!mobilePollInterval) {
    mobilePollInterval = setInterval(refreshMobileLogs, 4000);
  }
}

function closeMobileModal() {
  const modal = document.getElementById('mobile-modal');
  if (modal) modal.style.display = 'none';
  if (mobilePollInterval) {
    clearInterval(mobilePollInterval);
    mobilePollInterval = null;
  }
}

async function refreshMobileDevices() {
  try {
    const res = await fetch('/api/mobile/devices');
    const data = await res.json();
    const select = document.getElementById('mobile-device-select');
    if (select && data.devices) {
      select.innerHTML = '';
      data.devices.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = `${d.name} • ADB`;
        select.appendChild(opt);
      });
      const hasDevice = data.devices.length > 0;
      const empty = document.getElementById('mobile-empty-state');
      const phone = document.getElementById('mobile-phone-frame');
      if (empty) empty.style.display = hasDevice ? 'none' : 'flex';
      if (phone) phone.style.display = hasDevice ? 'flex' : 'none';
      document.querySelectorAll('#mobile-modal .warden-preset-btn, #mobile-modal .phone-icon-btn').forEach(button => { button.disabled = !hasDevice; });
      if (!hasDevice) select.innerHTML = '<option value="">No ADB device connected</option>';
    }
  } catch (e) {
    console.error('Failed to load mobile devices:', e);
  }
}

async function executeMobileAction(action) {
  const select = document.getElementById('mobile-device-select');
  const deviceId = select ? select.value : 'pixel-8-virtual';
  
  try {
    const res = await fetch('/api/mobile/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, ...action })
    });
    const result = await res.json();
    await refreshMobileScreen();
    await refreshMobileLogs();
    return result;
  } catch (e) {
    console.error('Mobile action error:', e);
  }
}

async function refreshMobileScreen() {
  const select = document.getElementById('mobile-device-select');
  const deviceId = select ? select.value : 'pixel-8-virtual';
  try {
    const res = await fetch(`/api/mobile/screen?deviceId=${deviceId}`);
    const data = await res.json();
    const titleEl = document.getElementById('phone-app-title');
    const subEl = document.getElementById('phone-sub-state');
    if (titleEl && data.foregroundPackage) {
      titleEl.textContent = data.foregroundPackage.split('.').pop() || 'Android';
    }
    if (subEl && data.foregroundPackage) {
      subEl.textContent = `Foreground: ${data.foregroundPackage}`;
    }
  } catch (e) {
    console.error('Screen refresh error:', e);
  }
}

async function refreshMobileLogs() {
  try {
    const res = await fetch('/api/mobile/logs');
    const data = await res.json();
    const container = document.getElementById('mobile-logs-container');
    if (!container || !data.logs) return;

    if (data.logs.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:12px;">No actions recorded yet. Tap on screen or click actions above.</div>';
      return;
    }

    container.innerHTML = '';
    data.logs.slice(0, 15).forEach(l => {
      const card = document.createElement('div');
      card.className = 'mobile-log-card';
      const badgeColor = l.verdict === 'AUTO_ALLOW' ? '#10b981' : l.verdict === 'NEEDS_CONFIRM' ? '#f59e0b' : '#ef4444';
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-weight:600;font-family:var(--font-mono);">${escapeHtml(l.action.toUpperCase())}</span>
          <span style="font-size:10px;font-weight:600;color:${badgeColor};border:1px solid ${badgeColor};padding:1px 5px;border-radius:4px;">${l.verdict}</span>
        </div>
        <div style="font-size:10.5px;color:var(--text-secondary);font-family:var(--font-mono);">${escapeHtml(l.output || l.reason || '')}</div>
        <div style="font-size:9.5px;color:var(--text-muted);text-align:right;">${l.latencyMs}ms • ${new Date(l.timestamp).toLocaleTimeString()}</div>
      `;
      container.appendChild(card);
    });
  } catch (e) {
    console.error('Failed to refresh mobile logs:', e);
  }
}

function bindEvents() {
  // Wallet
  elements.connectBtn?.addEventListener('click', connectMetaMaskWallet);
  elements.connectSolanaBtn?.addEventListener('click', connectSolanaWallet);
  elements.disconnectBtn?.addEventListener('click', disconnectWallet);

  // New Chat
  elements.newChatBtn?.addEventListener('click', createNewChat);

  // Sidebar Feature Navigation
  elements.navProjects?.addEventListener('click', (e) => { e.preventDefault(); openProjectsModal(); });
  elements.navArtifacts?.addEventListener('click', (e) => { e.preventDefault(); openArtifactsModal(); });
  elements.navWarden?.addEventListener('click', (e) => { e.preventDefault(); openWardenModal(); });
  elements.navRouter?.addEventListener('click', (e) => { e.preventDefault(); openRouterModal(); });
  elements.navRewards?.addEventListener('click', (e) => { e.preventDefault(); openRewardsModal(); });

  // Modals Close
  elements.projectsClose?.addEventListener('click', () => { elements.projectsModal.style.display = 'none'; });
  elements.artifactsClose?.addEventListener('click', () => { elements.artifactsModal.style.display = 'none'; });
  elements.wardenClose?.addEventListener('click', () => { elements.wardenModal.style.display = 'none'; });
  elements.routerClose?.addEventListener('click', () => { elements.routerModal.style.display = 'none'; });
  elements.searchClose?.addEventListener('click', () => { elements.searchModal.style.display = 'none'; });
  elements.tierClose?.addEventListener('click', () => { elements.tierModal.style.display = 'none'; });
  elements.rewardsClose?.addEventListener('click', () => { if (elements.rewardsModal) elements.rewardsModal.style.display = 'none'; });

  // Modal Backdrop Click
  [elements.projectsModal, elements.artifactsModal, elements.wardenModal, elements.routerModal, elements.searchModal, elements.tierModal, elements.rewardsModal].forEach(m => {
    m?.addEventListener('click', (e) => {
      if (e.target === m) m.style.display = 'none';
    });
  });

  // Holder Hub & Solana Rewards Tabs & Actions
  elements.rewardsTabs?.querySelectorAll('.tier-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      if (tabName) switchRewardsTab(tabName);
    });
  });

  elements.rewardsCopyCa?.addEventListener('click', () => {
    navigator.clipboard.writeText('AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump');
    if (elements.rewardsCopyCa) {
      elements.rewardsCopyCa.textContent = 'Copied!';
      setTimeout(() => { if (elements.rewardsCopyCa) elements.rewardsCopyCa.textContent = 'Copy'; }, 1500);
    }
  });

  elements.btnTriggerAccrual?.addEventListener('click', triggerCreditAccrual);
  elements.btnRefreshEligibility?.addEventListener('click', loadRewardsHubData);
  elements.btnSubmitTransfer?.addEventListener('click', submitCreditTransfer);
  const burnSlider = document.getElementById('burn-credit-slider');
  const redeemInput = document.getElementById('redeem-credit-input');
  burnSlider?.addEventListener('input', (e) => {
    if (redeemInput) redeemInput.value = e.target.value;
    updateRedeemPreview();
  });
  redeemInput?.addEventListener('input', (e) => {
    if (burnSlider) burnSlider.value = e.target.value;
    updateRedeemPreview();
  });
  elements.btnSubmitRedeem?.addEventListener('click', submitRedemptionClaim);
  elements.btnRefreshHistory?.addEventListener('click', loadRewardsLedgerHistory);
  elements.btnLoadOperatorClaims?.addEventListener('click', loadOperatorClaims);
  elements.btnConfirmOperatorTx?.addEventListener('click', confirmOperatorTransfer);

  // Burn-to-Boost Controls
  document.getElementById('btn-verify-boost')?.addEventListener('click', handleBoostVerification);
  document.getElementById('btn-refresh-boost')?.addEventListener('click', loadBoostStatus);
  document.getElementById('btn-copy-burn-addr')?.addEventListener('click', () => {
    navigator.clipboard.writeText('1nc1nerator11111111111111111111111111111111');
    const b = document.getElementById('btn-copy-burn-addr');
    if (b) {
      b.textContent = 'Copied!';
      setTimeout(() => { b.textContent = 'Copy Burn Address'; }, 1500);
    }
  });

  // Jev Brain CLI Controls
  document.getElementById('nav-cli')?.addEventListener('click', (e) => {
    e.preventDefault();
    openRewardsModal();
    switchRewardsTab('cli');
  });

  document.getElementById('btn-generate-first-cli-key')?.addEventListener('click', generateCliApiKey);
  document.getElementById('btn-generate-cli-key')?.addEventListener('click', generateCliApiKey);
  document.getElementById('btn-revoke-cli-key')?.addEventListener('click', revokeCliApiKey);
  document.getElementById('btn-delete-cli-key')?.addEventListener('click', deleteCliApiKey);
  document.getElementById('btn-toggle-cli-key')?.addEventListener('click', toggleCliKeyVisibility);
  document.getElementById('btn-copy-cli-key')?.addEventListener('click', copyCliApiKey);

  document.querySelectorAll('.copy-snippet-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        navigator.clipboard.writeText(targetEl.textContent.trim());
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = originalText; }, 1500);
      }
    });
  });

  // Projects Modal
  elements.btnCreateProject?.addEventListener('click', handleCreateProject);

  // Artifacts Modal
  elements.btnCopyArtifact?.addEventListener('click', copyActiveArtifact);
  elements.btnDownloadArtifact?.addEventListener('click', downloadActiveArtifact);

  // Warden Presets & Test
  elements.btnRunWarden?.addEventListener('click', () => runWardenCheck());
  document.querySelectorAll('.warden-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd');
      elements.wardenInput.value = cmd;
      runWardenCheck(cmd);
    });
  });

  // Router Search & Tier Filter Tabs
  elements.routerModelSearch?.addEventListener('input', filterRouterModels);
  document.querySelectorAll('#router-tier-tabs .tier-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#router-tier-tabs .tier-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRouterTierFilter = btn.getAttribute('data-tier') || 'all';
      filterRouterModels();
    });
  });

  // Profile Bottom Actions
  elements.btnProfileDownload?.addEventListener('click', () => exportCurrentChat('md'));
  elements.btnProfileSearch?.addEventListener('click', openSearchModal);
  elements.chatSearchInput?.addEventListener('input', handleSearchMessages);
  elements.btnExportJson?.addEventListener('click', () => exportCurrentChat('json'));
  elements.btnExportMd?.addEventListener('click', () => exportCurrentChat('md'));

  // Tier Pill
  elements.tierPill?.addEventListener('click', (e) => {
    if (e.target.id === 'disconnect-btn') return;
    elements.tierModal.style.display = 'flex';
  });

  // Token Popover toggle on Topbar MC Pill
  const tokenPopover = document.getElementById('token-popover');
  elements.mcPill?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (tokenPopover) {
      tokenPopover.style.display = tokenPopover.style.display === 'none' ? 'flex' : 'none';
    }
  });
  document.addEventListener('click', (e) => {
    if (tokenPopover && tokenPopover.style.display !== 'none') {
      if (!tokenPopover.contains(e.target) && !elements.mcPill.contains(e.target)) {
        tokenPopover.style.display = 'none';
      }
    }
  });
  document.getElementById('popover-tier-btn')?.addEventListener('click', () => {
    if (tokenPopover) tokenPopover.style.display = 'none';
    elements.tierModal.style.display = 'flex';
  });

  // Sidebar Collapse & Mobile Drawer
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  elements.collapseBtn?.addEventListener('click', () => {
    elements.sidebar.classList.add('collapsed');
    elements.reopenBtn?.classList.add('visible');
    elements.sidebar.classList.remove('mobile-open');
    sidebarBackdrop?.classList.remove('visible');
  });
  elements.reopenBtn?.addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      elements.sidebar.classList.toggle('mobile-open');
      sidebarBackdrop?.classList.toggle('visible', elements.sidebar.classList.contains('mobile-open'));
    } else {
      elements.sidebar.classList.remove('collapsed');
      elements.reopenBtn.classList.remove('visible');
    }
  });
  sidebarBackdrop?.addEventListener('click', () => {
    elements.sidebar.classList.remove('mobile-open');
    sidebarBackdrop.classList.remove('visible');
  });

  // Close mobile drawer on navigation click
  document.querySelectorAll('.sidebar-nav .nav-link, .new-chat-pill').forEach(el => {
    el.addEventListener('click', () => {
      if (window.innerWidth <= 768) {
        elements.sidebar.classList.remove('mobile-open');
        sidebarBackdrop?.classList.remove('visible');
      }
    });
  });

  // Chat Input
  elements.attachBtn?.addEventListener('click', () => elements.attachmentInput?.click());
  elements.attachmentInput?.addEventListener('change', event => handleAttachment(event.target.files?.[0]));
  elements.attachmentChip?.addEventListener('click', () => {
    pendingAttachment = null;
    elements.attachmentChip.hidden = true;
    if (elements.attachmentInput) elements.attachmentInput.value = '';
  });
  elements.voiceBtn?.addEventListener('click', toggleVoiceDictation);
  elements.audioBtn?.addEventListener('click', toggleAudioRecording);
  elements.modelInlineSearch?.addEventListener('input', event => refreshInlineModelOptions(event.target.value));

  elements.input?.addEventListener('input', () => {
    elements.input.style.height = 'auto';
    elements.input.style.height = Math.min(elements.input.scrollHeight, 180) + 'px';
  });
  elements.input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  });
  elements.sendBtn?.addEventListener('click', handleSubmit);

  // Web3 & Wallet Modals & Topbar Events
  const topbarWalletBtn = document.getElementById('topbar-connect-wallet-btn');
  const walletModal = document.getElementById('rainbow-modal');
  const walletModalClose = document.getElementById('rainbow-modal-close');
  const walletModalConn = document.getElementById('rainbow-modal-connect-btn');
  const walletModalSolana = document.getElementById('rainbow-modal-solana-btn');
  const walletModalVip = document.getElementById('rainbow-modal-vip-btn');
  const walletModalDisc = document.getElementById('rainbow-modal-disconnect-btn');

  const topbarBuyBtn = document.getElementById('topbar-buy-credits-btn');
  topbarBuyBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    openRewardsModalWithTab('transfer');
  });

  topbarWalletBtn?.addEventListener('click', () => {
    if (walletModal) walletModal.style.display = 'flex';
  });

  walletModalClose?.addEventListener('click', () => {
    if (walletModal) walletModal.style.display = 'none';
  });

  walletModalConn?.addEventListener('click', async () => {
    await connectMetaMaskWallet();
    if (walletModal) walletModal.style.display = 'none';
  });

  walletModalSolana?.addEventListener('click', async () => {
    await connectSolanaWallet();
    if (walletModal) walletModal.style.display = 'none';
  });

  walletModalVip?.addEventListener('click', async () => {
    const vipWallet = 'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn';
    const vipKey = `jev_live_vip_${vipWallet}`;
    sessionStorage.setItem(STORAGE_SESSION_TOKEN, vipKey);
    localStorage.setItem(STORAGE_SESSION_TOKEN, vipKey);
    sessionStorage.setItem('jev_session_token', vipKey);
    localStorage.setItem('jev_session_token', vipKey);
    localStorage.setItem(STORAGE_WALLET_KEY, vipWallet);
    localStorage.setItem('jev_wallet_address', vipWallet);

    const vipTier = {
      tierId: 5,
      tierLevel: 5,
      tierName: 'Dynasty Magnate (VIP Whitelist)',
      tokensHeld: 1000000,
      bagUsdValue: '$50,000+',
      creditRatePerHour: 5000,
      allowedModels: ['all'],
      isWhitelisted: true
    };
    await onWalletAuthenticated(vipWallet, 1000000, vipTier);
    showNotification('VIP Operator Authority Unlocked (Tier 5)', 'success');
    if (walletModal) walletModal.style.display = 'none';
  });

  walletModalDisc?.addEventListener('click', () => {
    disconnectWallet();
    if (walletModal) walletModal.style.display = 'none';
  });

  // Onboarding Form & Profile Editing Events
  elements.onboardingForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = elements.onboardingNameInput ? elements.onboardingNameInput.value.trim() : '';
    const email = elements.onboardingEmailInput ? elements.onboardingEmailInput.value.trim() : '';
    if (!name) {
      alert('Please enter your name.');
      return;
    }
    if (!email) {
      alert('Please enter your email address.');
      return;
    }
    if (currentWallet) {
      await saveUserProfile(currentWallet, name, email);
      if (elements.onboardingModal) elements.onboardingModal.style.display = 'none';
    }
  });

  elements.onboardingClose?.addEventListener('click', () => {
    if (elements.onboardingModal) elements.onboardingModal.style.display = 'none';
  });

  elements.profileBar?.addEventListener('click', () => {
    if (currentWallet) {
      promptOnboarding(currentWallet);
    }
  });


  // Mobile Runner Events
  document.getElementById('nav-mobile')?.addEventListener('click', (e) => {
    e.preventDefault();
    openMobileModal();
  });
  document.getElementById('mobile-modal-close')?.addEventListener('click', closeMobileModal);
  document.getElementById('btn-refresh-devices')?.addEventListener('click', refreshMobileDevices);

  // Phone screen canvas click for direct tap
  const phoneCanvas = document.getElementById('phone-screen-canvas');
  phoneCanvas?.addEventListener('click', (e) => {
    if (e.target.closest('.phone-nav-bar') || e.target.closest('.phone-icon-btn')) return;
    const rect = phoneCanvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const scaledX = Math.round((clickX / rect.width) * 1080);
    const scaledY = Math.round((clickY / rect.height) * 2400);

    const ripple = document.getElementById('phone-tap-indicator');
    if (ripple) {
      ripple.style.left = clickX + 'px';
      ripple.style.top = clickY + 'px';
      ripple.style.display = 'block';
      setTimeout(() => { ripple.style.display = 'none'; }, 400);
    }

    executeMobileAction({ type: 'tap', x: scaledX, y: scaledY });
  });

  document.querySelectorAll('.phone-icon-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      const pkg = btn.getAttribute('data-pkg');
      const x = btn.getAttribute('data-x');
      const y = btn.getAttribute('data-y');
      if (action === 'launch') {
        executeMobileAction({ type: 'launch', package: pkg });
      } else {
        executeMobileAction({ type: 'tap', x: parseInt(x, 10), y: parseInt(y, 10) });
      }
    });
  });

  document.getElementById('btn-phone-back')?.addEventListener('click', () => executeMobileAction({ type: 'key', key: 'BACK' }));
  document.getElementById('btn-phone-home')?.addEventListener('click', () => executeMobileAction({ type: 'key', key: 'HOME' }));
  document.getElementById('btn-phone-recents')?.addEventListener('click', () => executeMobileAction({ type: 'key', key: 'APP_SWITCH' }));

  document.getElementById('btn-mobile-open-chrome')?.addEventListener('click', () => executeMobileAction({ type: 'launch', package: 'com.android.chrome' }));
  document.getElementById('btn-mobile-open-settings')?.addEventListener('click', () => executeMobileAction({ type: 'launch', package: 'com.android.settings' }));
  document.getElementById('btn-mobile-type')?.addEventListener('click', () => executeMobileAction({ type: 'type', text: 'Jev Brain Autonomous Agent' }));
  document.getElementById('btn-mobile-swipe-up')?.addEventListener('click', () => executeMobileAction({ type: 'swipe', x1: 540, y1: 1800, x2: 540, y2: 600, duration: 250 }));
  document.getElementById('btn-mobile-inspect')?.addEventListener('click', refreshMobileScreen);

  // Contract Address (CA) One-Click Copy
  document.getElementById('copy-ca-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    copyCA();
  });
  document.getElementById('ca-pill')?.addEventListener('click', () => {
    copyCA();
  });
  document.getElementById('hero-copy-ca')?.addEventListener('click', (e) => {
    e.stopPropagation();
    copyCA();
  });
  document.getElementById('strip-copy-ca-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    copyCA();
  });

  // Starter Cards Action Handlers
  document.querySelectorAll('.starter-card').forEach(card => {
    card.addEventListener('click', () => {
      const starter = card.getAttribute('data-starter');
      if (starter === 'conversation') {
        if (elements.input) {
          elements.input.value = 'Explain how Jev Brain multi-model routing optimizes latency and reduces inference costs.';
          elements.input.focus();
          elements.input.dispatchEvent(new Event('input'));
        }
      } else if (starter === 'code') {
        if (elements.input) {
          elements.input.value = 'Review the following code architecture for performance bottlenecks, concurrency issues, and safety risks:\n\n```js\n// Paste code here\n```';
          elements.input.focus();
          elements.input.dispatchEvent(new Event('input'));
        }
      } else if (starter === 'project') {
        openProjectsModal();
      } else if (starter === 'warden') {
        openWardenModal();
      }
    });
  });

  // Sidebar Extra Action Triggers
  document.getElementById('sidebar-search-btn')?.addEventListener('click', openSearchModal);
  document.getElementById('sidebar-export-btn')?.addEventListener('click', () => exportCurrentChat('md'));
  document.getElementById('sidebar-quick-verify')?.addEventListener('click', () => {
    if (elements.tierModal) elements.tierModal.style.display = 'flex';
  });

  // Keyboard Shortcuts (Ctrl+N for new chat, Ctrl+B for sidebar toggle)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      createNewChat();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      elements.sidebar.classList.toggle('collapsed');
      elements.reopenBtn?.classList.toggle('visible', elements.sidebar.classList.contains('collapsed'));
    }
  });

}

// ============================================
// THEME SWITCHER (DEFAULT: BLACK/DARK, TOGGLEABLE TO LIGHT)
// ============================================
function initThemeToggle() {
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const themeLabel = document.getElementById('theme-label');
  const themeIcon = document.getElementById('theme-icon');

  function applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      document.body.classList.remove('dark-theme');
      document.body.classList.add('light-theme');
      if (themeLabel) themeLabel.textContent = 'Dark';
      if (themeIcon) {
        themeIcon.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
          </svg>
        `;
      }
      if (themeToggleBtn) themeToggleBtn.title = 'Switch to Dark (Black) Mode';
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.body.classList.remove('light-theme');
      document.body.classList.add('dark-theme');
      if (themeLabel) themeLabel.textContent = 'Light';
      if (themeIcon) {
        themeIcon.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line>
            <line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
          </svg>
        `;
      }
      if (themeToggleBtn) themeToggleBtn.title = 'Switch to Light Mode';
    }
  }

  // Default is dark (black) unless explicitly saved as 'light'
  let savedTheme = 'dark';
  try {
    savedTheme = localStorage.getItem('jev_theme') === 'light' ? 'light' : 'dark';
  } catch {}
  applyTheme(savedTheme);

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'dark';
      const nextTheme = current === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('jev_theme', nextTheme);
      } catch {}
      applyTheme(nextTheme);
      showNotification(`Theme set to ${nextTheme === 'dark' ? 'Black (Dark Mode)' : 'White (Light Mode)'}`, 'info');
    });
  }
}

// ============================================
// MOBILE IN-APP BROWSER AUTO-CONNECT HANDOFF
// ============================================
async function handleMobileAutoConnect() {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const autoConnect = params.get('auto_connect');
  if (!autoConnect) return;

  // If already authenticated with active session, just strip param
  if (currentWallet && getSessionToken()) {
    params.delete('auto_connect');
    const cleanSearch = params.toString() ? `?${params.toString()}` : '';
    window.history.replaceState({}, document.title, window.location.pathname + cleanSearch + window.location.hash);
    return;
  }

  // Clean the auto_connect query param from the URL immediately so page reloads don't loop
  params.delete('auto_connect');
  const cleanSearch = params.toString() ? `?${params.toString()}` : '';
  const cleanUrl = window.location.pathname + cleanSearch + window.location.hash;
  window.history.replaceState({}, document.title, cleanUrl);

  console.log(`📱 Mobile Auto-Connect detected for: ${autoConnect}. Awaiting wallet provider injection...`);

  // Polling helper to wait for wallet provider injection inside mobile in-app browser
  const pollForProvider = (checkFn, maxWaitMs = 2500, intervalMs = 100) => {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        const result = checkFn();
        if (result || (Date.now() - startTime) >= maxWaitMs) {
          clearInterval(interval);
          resolve(result);
        }
      }, intervalMs);
    });
  };

  if (autoConnect === 'phantom') {
    const solana = await pollForProvider(() => {
      return (window.phantom?.solana?.isPhantom ? window.phantom.solana : (window.solana?.isPhantom ? window.solana : window.solana));
    });
    if (solana) {
      console.log('⚡ Phantom provider detected in in-app browser. Triggering connection...');
      await connectSolanaWallet();
    } else {
      console.warn('Phantom provider injection timed out in in-app browser.');
    }
  } else if (autoConnect === 'metamask') {
    const provider = await pollForProvider(() => getWeb3Provider());
    if (provider) {
      console.log('🦊 MetaMask provider detected in in-app browser. Triggering connection...');
      await connectMetaMaskWallet();
    } else {
      console.warn('MetaMask provider injection timed out in in-app browser.');
    }
  }
}

// Expose for testing
if (typeof window !== 'undefined') {
  window.handleMobileAutoConnect = handleMobileAutoConnect;
}

// ============================================
// APP INITIALIZATION
// ============================================
async function init() {
  console.log('⚡ Jev Brain — Initializing Legit Web3 AI Platform');
  initThemeToggle();
  bindEvents();
  registerWalletProviderListeners();
  initChats();
  await loadMarketInfo();
  await loadOpenRouterModels();
  setInterval(loadMarketInfo, 15000); // 15s Live DexScreener Polling

  // Check persisted wallet, but never trust the locally cached tier blindly:
  // the saved session token must validate against the server first.
  const savedWallet = localStorage.getItem(STORAGE_WALLET_KEY) || localStorage.getItem('jev_wallet_address');
  if (savedWallet === 'HqHQf559KsuC7dKaSdUMu7v3gzy3v8BdmK4qBiGhjbSn') {
    const vipKey = `jev_live_vip_${savedWallet}`;
    sessionStorage.setItem(STORAGE_SESSION_TOKEN, vipKey);
    localStorage.setItem(STORAGE_SESSION_TOKEN, vipKey);
    sessionStorage.setItem('jev_session_token', vipKey);
    localStorage.setItem('jev_session_token', vipKey);
    localStorage.setItem(STORAGE_WALLET_KEY, savedWallet);
    localStorage.setItem('jev_wallet_address', savedWallet);
    const vipTier = {
      tierId: 5,
      tierLevel: 5,
      tierName: 'Dynasty Magnate (VIP Whitelist)',
      tokensHeld: 1000000,
      bagUsdValue: '$50,000+',
      creditRatePerHour: 5000,
      allowedModels: ['all'],
      isWhitelisted: true
    };
    await onWalletAuthenticated(savedWallet, 1000000, vipTier);
  } else if (savedWallet) {
    try {
      const savedTier = JSON.parse(localStorage.getItem(STORAGE_TIER_PREFIX + savedWallet.toLowerCase()) || 'null');
      if (!savedTier || !getSessionToken()) {
        elements.gateOverlay.style.display = 'flex';
      } else {
        const validation = await fetch('/api/session/validate', { headers: authHeaders() });
        const validationData = await validation.json().catch(() => ({}));
        const isMatch = validationData.address && (
          validationData.address.toLowerCase() === savedWallet.toLowerCase() ||
          validationData.address === savedWallet
        );
        if (validation.ok && validationData.valid && isMatch) {
          await onWalletAuthenticated(savedWallet, 0, savedTier);
        } else {
          // Stale/expired session: force a fresh wallet signature.
          sessionStorage.removeItem(STORAGE_SESSION_TOKEN);
          localStorage.removeItem(STORAGE_SESSION_TOKEN);
          elements.gateOverlay.style.display = 'flex';
        }
      }
    } catch {
      disconnectWallet();
    }
  } else {
    elements.gateOverlay.style.display = 'flex';
  }

  // Handle mobile in-app browser auto-connect handoff
  await handleMobileAutoConnect();
}

// Start
init();

// Expose global window hooks for inline onclick handlers
window.switchRewardsTab = switchRewardsTab;
window.openRewardsModal = openRewardsModal;
window.openRewardsModalWithTab = openRewardsModalWithTab;
window.switchP2PSubTab = switchP2PSubTab;
window.updateP2PModalAvailDisplay = updateP2PModalAvailDisplay;
window.setP2PModalSellCredits = setP2PModalSellCredits;
window.updateP2PModalSellPreview = updateP2PModalSellPreview;
window.loadP2PMarketOrders = loadP2PMarketOrders;
window.submitP2PModalListing = submitP2PModalListing;
window.cancelModalP2POrder = cancelModalP2POrder;
window.executeModalP2PBuy = executeModalP2PBuy;

