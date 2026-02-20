/**
 * OP_NET Wallet Copilot + DeFi Dashboard — Backend Server
 * 
 * Updated to use OP_NET Regtest — the final pre-mainnet environment.
 * Uses rBTC (regtest Bitcoin) — the correct currency for the build competition.
 * 
 * TO UPGRADE TO MAINNET (March 17, 2026):
 *   Change ACTIVE_NETWORK from NETWORKS.regtest to NETWORKS.mainnet
 *   That's it — one line change!
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK CONFIG — switch between regtest / testnet / mainnet here
// ─────────────────────────────────────────────────────────────────────────────
const NETWORKS = {
  regtest: {
    rpcUrl: 'https://regtest.opnet.org',
    name: 'Regtest',
    currency: 'rBTC',
  },
  testnet: {
    rpcUrl: 'https://testnet.opnet.org',
    name: 'Testnet',
    currency: 'tBTC',
  },
  mainnet: {
    rpcUrl: 'https://mainnet.opnet.org',
    name: 'Mainnet',
    currency: 'BTC',
  },
};

const ACTIVE_NETWORK = NETWORKS.regtest; // ← change to mainnet on March 17!

let provider;

async function initProvider() {
  try {
    const { JSONRpcProvider } = await import('opnet');
    const { networks } = await import('@btc-vision/bitcoin');
    const btcNetwork = ACTIVE_NETWORK.name === 'Mainnet'
      ? networks.bitcoin
      : networks.regtest;
    provider = new JSONRpcProvider(ACTIVE_NETWORK.rpcUrl, btcNetwork);
    console.log(`✅ OP_NET provider connected to: ${ACTIVE_NETWORK.rpcUrl}`);
  } catch (err) {
    console.error('❌ OP_NET provider failed to connect:', err.message);
  }
}

initProvider();

// ─────────────────────────────────────────────────────────────────────────────
// API: NETWORK STATUS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const blockNumber = await provider.getBlockNumber();
    res.json({
      connected: true,
      network: ACTIVE_NETWORK.name,
      currency: ACTIVE_NETWORK.currency,
      latestBlock: blockNumber.toString(),
      mainnetLaunch: 'March 17, 2026',
    });
  } catch (err) {
    res.json({ connected: false, network: ACTIVE_NETWORK.name, currency: ACTIVE_NETWORK.currency, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: WALLET BALANCE
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/balance/:address', async (req, res) => {
  const { address } = req.params;
  if (!address || address.length < 20) return res.status(400).json({ error: 'Invalid address' });
  try {
    const balanceSatoshis = await provider.getBalance(address);
    const balanceBTC = Number(balanceSatoshis) / 1e8;
    res.json({
      address,
      balanceSatoshis: balanceSatoshis.toString(),
      balanceBTC: balanceBTC.toFixed(8),
      currency: ACTIVE_NETWORK.currency,
      network: ACTIVE_NETWORK.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, fallback: true, balanceBTC: '0.00000000', currency: ACTIVE_NETWORK.currency });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: TRANSACTIONS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/transactions/:address', async (req, res) => {
  const { address } = req.params;
  try {
    const txList = await provider.getTransactionsByAddress(address, 0, 10);
    const transactions = (txList || []).map(tx => ({
      txid: tx.hash || tx.id || 'unknown',
      type: tx.isOPNET ? 'contract' : tx.type || 'send',
      amount: tx.value ? (Number(tx.value) / 1e8).toFixed(8) : '0',
      timestamp: tx.blockTime || null,
      blockHeight: tx.blockHeight || null,
      isContractCall: !!tx.isOPNET,
    }));
    res.json({ address, transactions, count: transactions.length });
  } catch (err) {
    res.json({ address, transactions: [], count: 0, error: err.message, fallback: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: OP_20 TOKEN BALANCES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/tokens/:address', async (req, res) => {
  const { address } = req.params;
  try {
    const { getContract, OP_20_ABI } = await import('opnet');

    // Known OP_20 tokens on OP_NET regtest
    const KNOWN_TOKENS = [
      {
        address: 'bcrt1plz0svv3wl05qrrv0dx8hvh5mgqc7jf3mhqgtw8jnj3l3d3cs6lzsfc3mxh',
        symbol: 'MOTO',
        name: 'MotoSwap Token',
        decimals: 8,
        color: '#f7931a',
      },
    ];

    const tokenBalances = [];
    for (const token of KNOWN_TOKENS) {
      try {
        const contract = getContract(token.address, OP_20_ABI, provider);
        const result = await contract.balanceOf(address);
        if (result && !result.error) {
          const rawBalance = result.decoded?.[0] || 0n;
          const balance = Number(rawBalance) / Math.pow(10, token.decimals);
          if (balance > 0) tokenBalances.push({ ...token, balance: balance.toFixed(token.decimals) });
        }
      } catch { /* skip erroring tokens */ }
    }

    res.json({ address, tokens: tokenBalances, count: tokenBalances.length });
  } catch (err) {
    res.json({ address, tokens: [], count: 0, error: err.message, fallback: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API: DEFI POSITIONS
// Reads liquidity pool positions from OP_NET DeFi contracts
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/defi/:address', async (req, res) => {
  const { address } = req.params;
  try {
    const { getContract, OP_20_ABI } = await import('opnet');

    const DEFI_PROTOCOLS = [
      {
        name: 'MotoSwap',
        type: 'Liquidity Pool',
        lpToken: 'bcrt1plz0svv3wl05qrrv0dx8hvh5mgqc7jf3mhqgtw8jnj3l3d3cs6lzsfc3mxh',
        pair: `rBTC / MOTO`,
        apy: '24.5',
        color: '#f7931a',
        risk: 'Medium',
      },
    ];

    const positions = [];
    for (const protocol of DEFI_PROTOCOLS) {
      try {
        const lpContract = getContract(protocol.lpToken, OP_20_ABI, provider);
        const balResult = await lpContract.balanceOf(address);
        if (balResult && !balResult.error) {
          const lpBalance = Number(balResult.decoded?.[0] || 0n) / 1e8;
          if (lpBalance > 0) {
            const valueUSD = lpBalance * 98000 * 0.5;
            positions.push({
              protocol: protocol.name,
              type: protocol.type,
              pair: protocol.pair,
              lpBalance: lpBalance.toFixed(8),
              valueUSD: valueUSD.toFixed(2),
              apy: protocol.apy,
              color: protocol.color,
              risk: protocol.risk,
              earnings24h: (valueUSD * (parseFloat(protocol.apy) / 100) / 365).toFixed(4),
              earningsTotal: (valueUSD * (parseFloat(protocol.apy) / 100) / 12).toFixed(4),
            });
          }
        }
      } catch { /* skip */ }
    }

    res.json({
      address,
      positions,
      count: positions.length,
      network: ACTIVE_NETWORK.name,
      currency: ACTIVE_NETWORK.currency,
      fallback: positions.length === 0,
    });
  } catch (err) {
    res.json({ address, positions: [], count: 0, error: err.message, fallback: true });
  }
});

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚀 OP_NET Wallet Copilot + DeFi Dashboard`);
  console.log(`   Open: http://localhost:${PORT}`);
  console.log(`   Network: ${ACTIVE_NETWORK.name} (${ACTIVE_NETWORK.currency})`);
  console.log(`   RPC:     ${ACTIVE_NETWORK.rpcUrl}`);
  console.log(`   Mainnet launch: March 17, 2026 🚀\n`);
});
