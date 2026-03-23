// Blockchain Explorer panel — consumes chain.js for all state and WASM calls

import * as chain from './chain.js';

// --- UI-only state ---

let queryHistory = [];     // [{type, query, label}]  type: 'address'|'block'|'transaction'
let historyIndex = -1;
let lastExplorerResult = null;
let lastExplorerAddress = null;

// --- Logging ---

function log(msg, cls) {
  const el = document.getElementById('exp-log');
  const span = document.createElement('span');
  span.style.color = cls === 'ok' ? '#4ade80' : cls === 'err' ? '#f87171' : cls === 'info' ? '#60a5fa' : cls === 'data' ? '#f59e0b' : '#e0e0e0';
  span.textContent = msg + '\n';
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

// --- Helpers ---

function truncateAddr(addr) {
  if (!addr || addr.length < 16) return addr || '';
  return addr.slice(0, 8) + '...' + addr.slice(-8);
}

function formatTimestamp(ts) {
  if (!ts) return '—';
  if (ts < 1e12) ts *= 1000; // unix seconds → ms
  return new Date(ts).toLocaleString();
}

// --- Navigation ---

function historyLabel(entry) {
  if (entry.type === 'address') return 'addr:' + truncateAddr(entry.query);
  if (entry.type === 'block') return 'blk:' + entry.query;
  if (entry.type === 'transaction') return 'tx:' + truncateAddr(entry.query);
  return truncateAddr(entry.query);
}

function historyColor(entry) {
  if (entry.type === 'address') return '#10b981';
  if (entry.type === 'block') return '#60a5fa';
  if (entry.type === 'transaction') return '#f59e0b';
  return '#888';
}

function updateNavUI() {
  const nav = document.getElementById('exp-nav');
  const breadcrumbs = document.getElementById('exp-breadcrumbs');
  const backBtn = document.getElementById('exp-btn-back');

  if (queryHistory.length === 0) {
    nav.style.display = 'none';
    return;
  }

  nav.style.display = 'block';
  backBtn.disabled = historyIndex <= 0;

  breadcrumbs.innerHTML = '';
  for (let i = 0; i <= historyIndex; i++) {
    const entry = queryHistory[i];
    const crumb = document.createElement('span');
    const active = i === historyIndex;
    crumb.style.cssText = 'padding:2px 6px; border:1px solid #2a2a2a; background:#0d0d0d; cursor:pointer; color:' + (active ? historyColor(entry) : '#666') + '; border-radius:3px;';
    crumb.textContent = historyLabel(entry);
    crumb.title = entry.query;
    if (!active) {
      const idx = i;
      crumb.onclick = () => navigateTo(idx);
    }
    breadcrumbs.appendChild(crumb);
    if (i < historyIndex) {
      const arrow = document.createElement('span');
      arrow.style.cssText = 'color:#444; font-size:0.7rem;';
      arrow.textContent = ' › ';
      breadcrumbs.appendChild(arrow);
    }
  }
}

function navigateTo(idx) {
  historyIndex = idx;
  const entry = queryHistory[historyIndex];
  document.getElementById('exp-query').value = entry.query;
  updateNavUI();
  executeQuery(entry.query, true);
}

function navigateBack() {
  if (historyIndex <= 0) return;
  navigateTo(historyIndex - 1);
}

function pushHistory(type, query) {
  if (historyIndex < queryHistory.length - 1) {
    queryHistory.length = historyIndex + 1;
  }
  queryHistory.push({ type, query });
  historyIndex = queryHistory.length - 1;
  updateNavUI();
}

// --- Hide all result areas ---

function hideAllResults() {
  document.getElementById('exp-address-result').style.display = 'none';
  document.getElementById('exp-tx-result').style.display = 'none';
  document.getElementById('exp-balance-box').style.display = 'none';
  document.getElementById('exp-stats').style.display = 'none';
  document.getElementById('exp-utxo-wrap').style.display = 'none';
  document.getElementById('exp-tx-json').style.display = 'none';
}

// --- Unified Explorer ---

export async function explore() {
  const query = document.getElementById('exp-query').value.trim();
  if (!query) { log('Please enter a block height, block/tx ID, or address.', 'err'); return; }
  return executeQuery(query, false);
}

async function executeQuery(query, skipHistory) {
  document.getElementById('exp-btn-lookup').disabled = true;
  hideAllResults();

  try {
    const result = await chain.exploreQuery(query, (msg, cls) => log(msg, cls));

    if (result.type === 'address') {
      if (!skipHistory) pushHistory('address', result.address);
      await showAddressResult(result.address);
      return;
    }

    if (result.type === 'block') {
      if (!skipHistory) pushHistory('block', query);
      renderBlockDetailView(result);
      document.getElementById('exp-tx-result').style.display = 'block';
      log('Block ' + result.blockHeight.toLocaleString() + ' loaded — ' +
        (result.block.v2?.transactionCount || 0) + ' transactions', 'ok');
    } else if (result.type === 'transaction') {
      if (!skipHistory) pushHistory('transaction', query);
      renderTransactionView(result);
      document.getElementById('exp-tx-result').style.display = 'block';
      log('Transaction found in block ' + result.blockHeight.toLocaleString(), 'ok');
    }
  } catch (e) {
    log('ERROR: ' + e, 'err');
    console.error(e);
    throw e;
  } finally {
    document.getElementById('exp-btn-lookup').disabled = false;
  }
}

// --- Address Explorer (inline) ---

async function showAddressResult(addr) {
  if (!addr) { log('Please enter an address.', 'err'); return; }

  if (!chain.getFilterUrl()) {
    log('No filters loaded. Enable auto-sync in Syncer page.', 'err');
    document.getElementById('exp-btn-lookup').disabled = false;
    return;
  }
  if (!chain.getPeerUrl()) {
    log('No peer URL configured. Set one in the Syncer page.', 'err');
    document.getElementById('exp-btn-lookup').disabled = false;
    return;
  }

  // Show address result area
  document.getElementById('exp-address-result').style.display = 'block';

  // Reset sub-elements
  document.getElementById('exp-history-body').innerHTML = '';
  document.getElementById('exp-utxo-body').innerHTML = '';
  document.getElementById('exp-utxo-wrap').style.display = 'none';
  document.getElementById('exp-balance-box').style.display = 'none';
  document.getElementById('exp-stats').style.display = 'none';

  const startTime = performance.now();
  const logFn = (msg, cls) => log(msg, cls);

  try {
    let result = await chain.exploreAddress(addr, logFn);

    if (result.tooManyMatches) {
      const proceed = confirm(
        result.matchCount.toLocaleString() + ' filter matches found.\n\n' +
        'This will take a long time. Continue?'
      );
      if (!proceed) {
        log('Scan cancelled.', 'info');
        return;
      }
      result = await chain.exploreAddressUnlimited(addr, logFn);
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

    // Compute balance from unspent UTXOs (more accurate than received-sent
    // when history is incomplete due to block filter coverage)
    const utxoBalance = (() => {
      if (!result.utxos || result.utxos.length === 0) return result.balanceSC;
      const spentIds = new Set();
      for (const u of result.utxos) {
        if (u.direction === 'sent' && u.outputId) spentIds.add(u.outputId);
      }
      let sum = BigInt(0);
      for (const u of result.utxos) {
        if (u.direction === 'received' && u.outputId && !spentIds.has(u.outputId) && u.amountHastings) {
          sum += BigInt(u.amountHastings);
        }
      }
      return formatHastings(sum);
    })();

    // Show balance
    document.getElementById('exp-balance-box').style.display = 'block';
    document.getElementById('exp-balance-value').textContent = utxoBalance;
    document.getElementById('exp-received').textContent = '+' + result.receivedSC;
    document.getElementById('exp-sent').textContent = '-' + result.sentSC;
    document.getElementById('exp-scan-meta').textContent =
      result.filtersChecked + ' filters, ' + result.filterMatches + ' matches, ' +
      result.tailBlocksScanned + ' tail blocks, ' +
      result.falsePositives + ' false positives | ' + elapsed + 's';

    // Show stats
    document.getElementById('exp-stats').style.display = 'block';
    document.getElementById('exp-stat-summary').textContent =
      result.blocksScanned + ' blocks scanned, ' + result.transactionsFound + ' transactions found';

    // Populate History, UTXO, and Stats tabs
    if (result.utxos && result.utxos.length > 0) {
      populateHistoryTable(result.utxos);
      populateUtxoTable(result.utxos);
      populateStatsTab(result);
      document.getElementById('exp-utxo-wrap').style.display = 'block';
    }

    // Store result for JSON export
    lastExplorerResult = result;
    lastExplorerAddress = addr;

    log('Completed in ' + elapsed + 's', 'ok');
  } catch (e) {
    log('ERROR: ' + e, 'err');
    console.error(e);
  } finally {
    document.getElementById('exp-btn-lookup').disabled = false;
  }
}

// Look up a transaction by txid, with optional height hint fallback.
// If the txid isn't in the txindex (e.g. tail blocks), fetches the block at
// heightHint and finds the matching transaction within it.
export async function exploreTransaction(txid, heightHint) {
  document.getElementById('exp-query').value = txid;
  document.getElementById('exp-btn-lookup').disabled = true;
  hideAllResults();

  try {
    // Try normal txid lookup first
    const result = await chain.exploreQuery(txid, (msg, cls) => log(msg, cls));
    if (result.type === 'transaction') {
      pushHistory('transaction', txid);
      renderTransactionView(result);
      document.getElementById('exp-tx-result').style.display = 'block';
      log('Transaction found in block ' + result.blockHeight.toLocaleString(), 'ok');
      return;
    }
    // If it came back as a block for some reason, render it
    pushHistory('block', txid);
    renderBlockDetailView(result);
    document.getElementById('exp-tx-result').style.display = 'block';
  } catch (e) {
    // Txid not found — try height hint fallback
    if (!heightHint) { log('ERROR: ' + e, 'err'); throw e; }

    log('Not in txindex, fetching block ' + heightHint + '...', 'info');
    try {
      const blockResult = await chain.exploreQuery(String(heightHint), (msg, cls) => log(msg, cls));
      if (blockResult.type === 'block' && blockResult.block?.v2?.transactions) {
        const txns = blockResult.block.v2.transactions;
        const txIndex = txns.findIndex(t => t.txid === txid);
        if (txIndex >= 0) {
          // Re-render as a transaction view with the matched index
          blockResult.type = 'transaction';
          blockResult.txIndex = txIndex;
          blockResult.txid = txid;
          pushHistory('transaction', txid);
          renderTransactionView(blockResult);
          document.getElementById('exp-tx-result').style.display = 'block';
          log('Transaction found in block ' + blockResult.blockHeight.toLocaleString(), 'ok');
          return;
        }
      }
      // Couldn't find tx in block — show the block anyway
      log('Transaction not found in block ' + heightHint + ', showing block.', 'info');
      pushHistory('block', String(heightHint));
      renderBlockDetailView(blockResult);
      document.getElementById('exp-tx-result').style.display = 'block';
    } catch (e2) {
      log('ERROR: ' + e2, 'err');
      throw e2;
    }
  } finally {
    document.getElementById('exp-btn-lookup').disabled = false;
  }
}

// Keep exported for external callers (e.g. makeAddrLink)
export async function exploreAddress(addr) {
  document.getElementById('exp-query').value = addr;
  explore();
}

function formatHastings(hastings) {
  const SC_PRECISION = BigInt('1000000000000000000000000'); // 10^24
  const whole = hastings / SC_PRECISION;
  const frac = hastings % SC_PRECISION;
  if (frac === BigInt(0)) return whole.toLocaleString() + ' SC';
  const fracStr = frac.toString().padStart(24, '0').replace(/0+$/, '');
  return whole.toLocaleString() + '.' + fracStr.slice(0, 4) + ' SC';
}

function truncHash(hash, n = 8) {
  if (!hash || hash.length <= n * 2 + 3) return hash || '';
  return hash.slice(0, n) + '\u2026' + hash.slice(-n);
}

function formatFilesize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// --- Block Detail View ---

// Helper: get address from a siacoin input (works for both v1 and v2 shapes)
function inputAddress(inp) {
  if (inp.parent && inp.parent.siacoinOutput) return inp.parent.siacoinOutput.address;
  return inp.address || '';
}
// Helper: get value from a siacoin input (works for both v1 and v2 shapes)
function inputValue(inp) {
  if (inp.parent && inp.parent.siacoinOutput) return BigInt(inp.parent.siacoinOutput.value);
  return inp.value ? BigInt(inp.value) : 0n;
}
// Helper: get maturity height from a siacoin input
function inputMaturityHeight(inp) {
  if (inp.parent) return inp.parent.maturityHeight || 0;
  return 0;
}
// Helper: check if transaction is v1 (has minerFees array instead of minerFee)
function isV1Txn(txn) {
  return Array.isArray(txn.minerFees);
}
// Helper: get total miner fee for a transaction (v1 or v2)
function txnMinerFee(txn) {
  if (Array.isArray(txn.minerFees)) {
    return txn.minerFees.reduce((s, f) => s + BigInt(f || '0'), 0n);
  }
  return BigInt(txn.minerFee || '0');
}

function classifyTransaction(txn) {
  const v1 = isV1Txn(txn);
  const pfx = v1 ? 'V1 ' : '';
  const resolutions = txn.fileContractResolutions || [];
  const contracts = txn.fileContracts || [];
  const revisions = txn.fileContractRevisions || [];
  const attestations = txn.attestations || [];
  const inputs = txn.siacoinInputs || [];
  const outputs = txn.siacoinOutputs || [];
  const hasArb = txn.arbitraryData && txn.arbitraryData.length > 0;

  if (resolutions.length > 0) {
    const t = resolutions[0].type;
    if (t === 'renewal') return { type: pfx + 'Contract Renewal', dot: 'dot-contract', desc: 'Renews file contract' };
    if (t === 'storageProof') return { type: pfx + 'Storage Proof', dot: 'dot-resolution', desc: 'Storage proof resolution' };
    if (t === 'expiration') return { type: pfx + 'Contract Expiration', dot: 'dot-resolution', desc: 'Contract expired' };
    return { type: pfx + 'Resolution', dot: 'dot-resolution', desc: 'Contract resolution' };
  }
  if (contracts.length > 0) {
    return { type: pfx + 'File Contract', dot: 'dot-contract', desc: 'Renter funds contract, host locks collateral' };
  }
  if (revisions.length > 0) {
    return { type: pfx + 'Contract Revision', dot: 'dot-contract', desc: 'Revises file contract' };
  }
  const storageProofs = txn.storageProofs || [];
  if (storageProofs.length > 0) {
    return { type: pfx + 'Storage Proof', dot: 'dot-resolution', desc: 'Storage proof' };
  }
  if (attestations.length > 0) {
    return { type: pfx + 'Attestation', dot: 'dot-attestation', desc: 'Attestation: ' + (attestations[0].key || '') };
  }
  if (hasArb && inputs.length === 0) {
    return { type: pfx + 'Arbitrary Data', dot: 'dot-attestation', desc: 'Encoded message' };
  }
  if (inputs.length > 0 && outputs.length > 0) {
    const inputAddrs = new Set(inputs.map(i => inputAddress(i)));
    const outputAddrs = new Set(outputs.map(o => o.address));
    const allSelf = [...outputAddrs].every(a => inputAddrs.has(a));
    const hasMature = inputs.some(i => inputMaturityHeight(i) > 0);
    if (hasMature && allSelf) {
      return { type: pfx + 'Miner Reward Spend', dot: 'dot-miner', desc: 'Spends matured miner reward' };
    }
    if (allSelf && inputAddrs.size === 1) {
      return { type: pfx + 'Batch Split', dot: 'dot-transfer', desc: 'Self-spent reshuffle' };
    }
    return { type: pfx + 'Transfer', dot: 'dot-transfer', desc: 'Siacoin transfer' };
  }
  return { type: pfx + 'Transaction', dot: 'dot-transfer', desc: '' };
}

function buildTransactionSummaryText(txn, cls) {
  const inputs = txn.siacoinInputs || [];
  const outputs = txn.siacoinOutputs || [];
  const fee = txnMinerFee(txn);
  const parts = [];

  if (inputs.length > 0) {
    const totalIn = inputs.reduce((s, i) => s + inputValue(i), 0n);
    if (totalIn > 0n) {
      parts.push('In: ' + formatHastings(totalIn));
    } else if (outputs.length > 0) {
      // v1 inputs don't carry parent value; show total output + fee instead
      const totalOut = outputs.reduce((s, o) => s + BigInt(o.value), 0n);
      parts.push('Out: ' + formatHastings(totalOut + fee));
    }
  }
  if (fee > 0n) parts.push('Fee: ' + formatHastings(fee));
  if (cls.desc) parts.push(cls.desc);
  return parts.join(' \u2022 ');
}

function renderBlockDetailView(result) {
  const headerEl = document.getElementById('exp-block-header');
  const txnsEl = document.getElementById('exp-block-txns');
  headerEl.innerHTML = '';
  txnsEl.innerHTML = '';

  headerEl.appendChild(buildBlockHeaderCard(result));

  // Miner payout card
  if (result.block.minerPayouts && result.block.minerPayouts.length > 0) {
    txnsEl.appendChild(buildMinerPayoutCard(result.block.minerPayouts, result.blockHeight));
  }

  // V1 transaction cards
  const v1Txns = result.block.v1Transactions || [];
  for (let i = 0; i < v1Txns.length; i++) {
    txnsEl.appendChild(buildTransactionCard(v1Txns[i], i, false));
  }

  // V2 transaction cards
  const txns = result.block.v2?.transactions || [];
  const highlightIndex = (result.txIndex != null) ? result.txIndex : -1;
  for (let i = 0; i < txns.length; i++) {
    txnsEl.appendChild(buildTransactionCard(txns[i], i, i === highlightIndex));
  }

  if (v1Txns.length === 0 && txns.length === 0 && (!result.block.minerPayouts || result.block.minerPayouts.length === 0)) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:#888; font-size:0.8rem; padding:1rem; text-align:center;';
    empty.textContent = 'No transactions in this block.';
    txnsEl.appendChild(empty);
  }

  // Raw JSON
  const jsonEl = document.getElementById('exp-tx-json');
  jsonEl.textContent = JSON.stringify(result.block, null, 2);
}

function renderTransactionView(result) {
  const headerEl = document.getElementById('exp-block-header');
  const txnsEl = document.getElementById('exp-block-txns');
  headerEl.innerHTML = '';
  txnsEl.innerHTML = '';

  // Compact block context line
  const ctx = document.createElement('div');
  ctx.className = 'block-card';
  ctx.style.cssText = 'padding:0.5rem 0.75rem; font-size:0.8rem; cursor:pointer;';
  ctx.innerHTML =
    '<span style="color:var(--text-secondary);">Block </span>' +
    '<span style="color:var(--color-blue);">' + result.blockHeight.toLocaleString() + '</span>' +
    '<span style="color:var(--text-muted); margin-left:0.75rem;">' + formatTimestamp(result.timestamp) + '</span>' +
    '<span style="color:var(--text-muted); float:right; font-size:0.7rem;">click to view full block</span>';
  ctx.addEventListener('click', () => {
    renderBlockDetailView(result);
    document.getElementById('exp-tx-json').style.display = 'none';
  });
  headerEl.appendChild(ctx);

  // Only the matched transaction card (expanded)
  if (result.v1TxIndex != null) {
    const v1Txns = result.block.v1Transactions || [];
    const v1Idx = result.v1TxIndex;
    if (v1Idx < v1Txns.length) {
      txnsEl.appendChild(buildTransactionCard(v1Txns[v1Idx], v1Idx, true));
    }
    const jsonEl = document.getElementById('exp-tx-json');
    jsonEl.textContent = JSON.stringify(v1Txns[v1Idx] || result.block, null, 2);
  } else {
    const txns = result.block.v2?.transactions || [];
    const txIndex = (result.txIndex != null) ? result.txIndex : 0;
    if (txIndex < txns.length) {
      txnsEl.appendChild(buildTransactionCard(txns[txIndex], txIndex, true));
    }
    const jsonEl = document.getElementById('exp-tx-json');
    jsonEl.textContent = JSON.stringify(txns[txIndex] || result.block, null, 2);
  }
}

function buildBlockHeaderCard(result) {
  const block = result.block;
  const card = document.createElement('div');
  card.className = 'block-card';

  const minerReward = (block.minerPayouts || []).reduce((s, p) => s + BigInt(p.value), 0n);
  const v1Txns = block.v1Transactions || [];
  const v2Txns = block.v2?.transactions || [];
  const v1Fees = v1Txns.reduce((s, t) => (t.minerFees || []).reduce((fs, f) => fs + BigInt(f || '0'), s), 0n);
  const v2Fees = v2Txns.reduce((s, t) => s + BigInt(t.minerFee || '0'), 0n);
  const totalFees = v1Fees + v2Fees;
  const v1Count = block.v1TransactionCount || v1Txns.length;
  const v2Count = block.v2?.transactionCount || v2Txns.length;
  // block timestamp is unix seconds
  const ts = block.timestamp < 1e12 ? block.timestamp * 1000 : block.timestamp;

  card.innerHTML =
    '<div class="block-card-header">' +
      '<span class="block-card-title">Block ' + result.blockHeight.toLocaleString() + '</span>' +
      '<span class="block-card-subtitle">Miner Reward: ' + formatHastings(minerReward) + '</span>' +
    '</div>' +
    '<div class="block-card-row">' +
      '<span style="color:var(--color-orange);">' + new Date(ts).toLocaleString() + '</span>' +
      '<span>Total Fees: ' + formatHastings(totalFees) + '</span>' +
    '</div>' +
    '<div class="block-card-row">' +
      '<span class="block-card-hash" title="' + (block.parentID || '') + '">Parent: ' + truncHash(block.parentID) + '</span>' +
      '<span>Nonce: ' + block.nonce + '</span>' +
    '</div>' +
    (v1Count > 0 ? '<div class="block-card-row"><span></span><span>' + v1Count + ' V1 Transaction' + (v1Count !== 1 ? 's' : '') + '</span></div>' : '') +
    (v2Count > 0 ? '<div class="block-card-row"><span></span><span>' + v2Count + ' V2 Transaction' + (v2Count !== 1 ? 's' : '') + '</span></div>' : '');

  return card;
}

function buildMinerPayoutCard(payouts, height) {
  const card = document.createElement('div');
  card.className = 'txn-card';

  const totalReward = payouts.reduce((s, p) => s + BigInt(p.value), 0n);

  const header = document.createElement('div');
  header.className = 'txn-card-header';
  header.innerHTML =
    '<div class="txn-card-left">' +
      '<span class="txn-type-dot dot-miner"></span>' +
      '<span class="txn-type-label">Miner Payout</span>' +
      '<span class="badge badge-orange">coinbase</span>' +
    '</div>' +
    '<div class="txn-card-right">' +
      '<span>' + payouts.length + ' Output' + (payouts.length !== 1 ? 's' : '') + '</span>' +
      '<span class="txn-chevron">\u25B8</span>' +
    '</div>';
  header.addEventListener('click', () => card.classList.toggle('expanded'));
  card.appendChild(header);

  const summary = document.createElement('div');
  summary.className = 'txn-summary';
  summary.textContent = 'Reward: ' + formatHastings(totalReward) + ' \u2022 Matures at height ' + (height + 144).toLocaleString();
  card.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'txn-body';
  let rendered = false;
  const observer = new MutationObserver(() => {
    if (card.classList.contains('expanded') && !rendered) {
      rendered = true;
      observer.disconnect();
      const title = document.createElement('div');
      title.className = 'io-column-title';
      title.textContent = 'Outputs';
      body.appendChild(title);
      for (const p of payouts) {
        const item = document.createElement('div');
        item.className = 'io-item';
        item.appendChild(makeAddrLink(p.address, 12));
        const valSpan = document.createElement('span');
        valSpan.className = 'io-val positive';
        valSpan.textContent = formatHastings(BigInt(p.value));
        item.appendChild(valSpan);
        body.appendChild(item);
      }
    }
  });
  observer.observe(card, { attributes: true, attributeFilter: ['class'] });
  card.appendChild(body);

  return card;
}

export function buildTransactionCard(txn, index, highlight) {
  const cls = classifyTransaction(txn);
  const card = document.createElement('div');
  card.className = 'txn-card';

  const inputs = txn.siacoinInputs || [];
  const outputs = txn.siacoinOutputs || [];
  const inputCount = inputs.length + (txn.siafundInputs || []).length;
  const outputCount = outputs.length + (txn.siafundOutputs || []).length;

  const txid = txn.txid || '';
  const header = document.createElement('div');
  header.className = 'txn-card-header';
  header.innerHTML =
    '<div class="txn-card-left">' +
      '<span class="txn-type-dot ' + cls.dot + '"></span>' +
      '<span class="txn-txid" title="' + txid + '">' + (txid ? truncHash(txid, 6) : 'Txn ' + (index + 1)) + '</span>' +
      '<span class="txn-type-label">' + cls.type + '</span>' +
    '</div>' +
    '<div class="txn-card-right">' +
      '<span>' + inputCount + ' Input' + (inputCount !== 1 ? 's' : '') + ' | ' + outputCount + ' Output' + (outputCount !== 1 ? 's' : '') + '</span>' +
      '<span class="txn-chevron">\u25B8</span>' +
    '</div>';
  header.addEventListener('click', (e) => {
    // Copy txid if clicking the txid span
    if (e.target.classList.contains('txn-txid') && txid) {
      navigator.clipboard.writeText(txid);
      const orig = e.target.textContent;
      e.target.textContent = 'copied!';
      setTimeout(() => { e.target.textContent = orig; }, 1000);
      return;
    }
    card.classList.toggle('expanded');
  });
  card.appendChild(header);

  const summary = document.createElement('div');
  summary.className = 'txn-summary';
  summary.textContent = buildTransactionSummaryText(txn, cls);
  card.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'txn-body';
  let rendered = false;
  const observer = new MutationObserver(() => {
    if (card.classList.contains('expanded') && !rendered) {
      rendered = true;
      observer.disconnect();
      body.appendChild(buildTransactionBody(txn, cls));
    }
  });
  observer.observe(card, { attributes: true, attributeFilter: ['class'] });
  card.appendChild(body);

  // Auto-expand and highlight the searched-for transaction
  if (highlight) {
    card.style.borderColor = 'var(--color-accent)';
    card.classList.add('expanded');
  }

  return card;
}

function buildTransactionBody(txn, cls) {
  const frag = document.createDocumentFragment();
  const contracts = txn.fileContracts || [];
  const resolutions = txn.fileContractResolutions || [];
  const revisions = txn.fileContractRevisions || [];
  const attestations = txn.attestations || [];

  const hasIO = (txn.siacoinInputs || []).length > 0 || (txn.siacoinOutputs || []).length > 0;

  // Appends IO grid + miner fee when inputs/outputs are present.
  // Called at the end of every branch so no card type silently drops IO detail.
  function appendIOAndFee() {
    if (hasIO) frag.appendChild(buildIOGrid(txn));
    const fee = txnMinerFee(txn);
    if (fee > 0n) {
      const feeEl = document.createElement('div');
      feeEl.style.cssText = 'margin-top:0.5rem; font-size:0.72rem; color:var(--text-secondary); text-align:right;';
      feeEl.textContent = 'Miner Fee: ' + formatHastings(fee);
      frag.appendChild(feeEl);
    }
  }

  // File contract: show flow diagram + detail panel
  if (contracts.length > 0) {
    const isV1Contract = !contracts[0].renterOutput;
    for (let i = 0; i < contracts.length; i++) {
      if (i > 0) {
        const sep = document.createElement('hr');
        sep.style.cssText = 'border:none; border-top:1px solid var(--border-default); margin:0.75rem 0;';
        frag.appendChild(sep);
      }
      if (isV1Contract) {
        frag.appendChild(buildV1ContractDetail(contracts[i]));
      } else {
        frag.appendChild(buildFileContractFlow(txn, contracts[i]));
        frag.appendChild(buildFileContractDetail(contracts[i]));
      }
    }
    appendIOAndFee();
    return frag;
  }

  // Contract resolution
  if (resolutions.length > 0) {
    for (const res of resolutions) {
      frag.appendChild(buildResolutionDetail(res));
    }
    appendIOAndFee();
    return frag;
  }

  // Contract revision
  if (revisions.length > 0) {
    for (const rev of revisions) {
      // v2 revisions have rev.revision; v1 revisions are flat
      const fc = rev.revision || rev;
      const isV1 = !rev.revision;
      const box = document.createElement('div');
      box.className = 'contract-box';
      box.innerHTML = '<div class="contract-box-title">Revised Contract</div>';
      box.appendChild(isV1 ? buildV1ContractDetail(fc) : buildFileContractDetail(fc));
      frag.appendChild(box);
    }
    appendIOAndFee();
    return frag;
  }

  // Attestation
  if (attestations.length > 0) {
    for (const att of attestations) {
      const box = document.createElement('div');
      box.className = 'detail-grid';
      let decodedValue = '';
      try { decodedValue = atob(att.value); } catch (_) { decodedValue = att.value; }
      box.innerHTML =
        '<span class="detail-label">Public Key</span><span class="detail-value">' + truncHash(att.publicKey, 12) + '</span>' +
        '<span class="detail-label">Key</span><span class="detail-value" style="font-family:inherit;">' + (att.key || '') + '</span>' +
        '<span class="detail-label">Value</span><span class="detail-value">' + decodedValue + '</span>';
      frag.appendChild(box);
    }
    appendIOAndFee();
    return frag;
  }

  // Arbitrary data
  if (txn.arbitraryData && txn.arbitraryData.length > 0) {
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--bg-surface); border:1px solid var(--border-default); border-radius:var(--radius-sm); padding:0.65rem; font-size:0.75rem;';
    let decoded = '';
    try { decoded = atob(txn.arbitraryData); } catch (_) { decoded = txn.arbitraryData; }
    const isNonSia = decoded.startsWith('NonSia');
    box.innerHTML =
      '<div style="color:var(--text-secondary); margin-bottom:0.35rem;">Arbitrary Data' +
      (isNonSia ? ' <span class="badge badge-orange">NonSia marker</span>' : '') + '</div>' +
      '<div style="color:var(--text-primary); word-break:break-all; font-family:var(--font-mono);">' +
      decoded.replace(/</g, '&lt;') + '</div>';
    frag.appendChild(box);
    appendIOAndFee();
    return frag;
  }

  // Default: IO grid + fee
  appendIOAndFee();
  return frag;
}

function makeAddrLink(addr, n) {
  const span = document.createElement('span');
  span.className = 'io-addr clickable';
  span.title = addr;
  span.textContent = truncHash(addr, n || 10);
  span.addEventListener('click', () => {
    document.getElementById('exp-query').value = addr;
    explore();
  });
  return span;
}

function buildIOGrid(txn) {
  const inputs = txn.siacoinInputs || [];
  const outputs = txn.siacoinOutputs || [];
  const grid = document.createElement('div');
  grid.className = 'io-grid';

  // Inputs column
  const inCol = document.createElement('div');
  inCol.innerHTML = '<div class="io-column-title">Inputs (' + inputs.length + ')</div>';
  for (const inp of inputs) {
    const addr = inputAddress(inp);
    const val = inputValue(inp);
    const item = document.createElement('div');
    item.className = 'io-item';
    item.appendChild(makeAddrLink(addr));
    const valSpan = document.createElement('span');
    valSpan.className = 'io-val';
    valSpan.textContent = val > 0n ? formatHastings(val) : '';
    item.appendChild(valSpan);
    inCol.appendChild(item);
  }

  // Outputs column
  const outCol = document.createElement('div');
  outCol.innerHTML = '<div class="io-column-title">Outputs (' + outputs.length + ')</div>';
  for (const out of outputs) {
    const val = BigInt(out.value);
    const item = document.createElement('div');
    item.className = 'io-item';
    item.appendChild(makeAddrLink(out.address));
    const valSpan = document.createElement('span');
    valSpan.className = 'io-val positive';
    valSpan.textContent = formatHastings(val);
    item.appendChild(valSpan);
    outCol.appendChild(item);
  }

  grid.append(inCol, outCol);
  return grid;
}

function buildFileContractFlow(txn, fc) {
  const inputs = txn.siacoinInputs || [];
  const outputs = txn.siacoinOutputs || [];
  const flow = document.createElement('div');
  flow.className = 'flow-container';

  // Left: Inputs
  const leftCol = document.createElement('div');
  leftCol.className = 'flow-column';
  leftCol.innerHTML = '<div class="io-column-title">Inputs</div>';
  for (const inp of inputs) {
    const addr = inputAddress(inp);
    const val = inputValue(inp);
    // Determine if this is renter or host input
    const isRenter = addr === fc.renterOutput.address || addr !== fc.hostOutput.address;
    const item = document.createElement('div');
    item.className = 'flow-item';
    item.innerHTML =
      '<div style="color:' + (isRenter ? 'var(--color-green)' : 'var(--color-red)') + '; font-weight:600; margin-bottom:3px;">' +
      (isRenter ? '\u2714 Renter Funds' : '\u26D4 Host Collateral') + '</div>' +
      '<div style="color:var(--text-primary);">' + (val > 0n ? formatHastings(val) : '') + '</div>';
    leftCol.appendChild(item);
  }

  // Center: Contract formed
  const center = document.createElement('div');
  center.className = 'flow-center';
  center.innerHTML =
    '<div class="flow-center-title">File Contract Formed</div>' +
    '<div class="flow-center-row">Expiration: <strong style="color:var(--text-primary);">' + fc.expirationHeight.toLocaleString() + '</strong></div>' +
    '<div class="flow-center-row">Proof Height: <strong style="color:var(--text-primary);">' + fc.proofHeight.toLocaleString() + '</strong></div>';

  // Right: Outputs
  const rightCol = document.createElement('div');
  rightCol.className = 'flow-column';
  rightCol.innerHTML = '<div class="io-column-title">Outputs</div>';
  for (const out of outputs) {
    const val = BigInt(out.value);
    const isRenter = out.address === fc.renterOutput.address;
    const item = document.createElement('div');
    item.className = 'flow-item';
    item.innerHTML =
      '<div style="color:' + (isRenter ? 'var(--color-green)' : 'var(--color-orange)') + '; font-weight:600; margin-bottom:3px;">' +
      (isRenter ? '\u2714 Renter Change' : '\uD83D\uDFE0 Host Change') + '</div>' +
      '<div style="color:var(--text-primary);">' + formatHastings(val) + '</div>';
    rightCol.appendChild(item);
  }

  flow.append(leftCol, center, rightCol);
  return flow;
}

// title: optional override for the "File Contract" heading
// contractId: optional state-element ID to display
function buildFileContractDetail(fc, title, contractId) {
  const box = document.createElement('div');
  box.className = 'contract-box';
  box.innerHTML = '<div class="contract-box-title">' + (title || 'File Contract') + '</div>';

  // Contract ID row (when caller passes the state-element id)
  if (contractId) {
    const idRow = document.createElement('div');
    idRow.style.cssText = 'font-size:0.72rem; color:var(--text-secondary); padding:0 0.1rem 0.4rem; font-family:var(--font-mono);';
    idRow.innerHTML = 'ID: <span style="color:var(--text-primary);" title="' + contractId + '">' + truncHash(contractId, 14) + '</span>';
    box.appendChild(idRow);
  }

  const parties = document.createElement('div');
  parties.className = 'contract-parties';

  // Renter panel
  const renter = document.createElement('div');
  renter.className = 'contract-party';
  const renterPayout = formatHastings(BigInt(fc.renterOutput.value));
  const renterKey = fc.renterPublicKey || '';
  const hasSig = fc.renterSignature && fc.renterSignature !== '0'.repeat(128);
  renter.innerHTML =
    '<div class="contract-party-header" style="background:rgba(74,222,128,0.1); color:var(--color-green);">Renter</div>' +
    '<div class="contract-party-body">' +
      '<div>' + truncHash(renterKey.replace('ed25519:', ''), 10) + '</div>' +
      '<div>Renter Payout: <span>' + renterPayout + '</span></div>' +
      '<div>' + (hasSig ? '\u2714\uFE0F Signed' : '\u274C Not signed') + '</div>' +
    '</div>';

  // Host panel
  const host = document.createElement('div');
  host.className = 'contract-party';
  const hostPayout = formatHastings(BigInt(fc.hostOutput.value));
  const missedHost = formatHastings(BigInt(fc.missedHostValue || '0'));
  const totalColl = formatHastings(BigInt(fc.totalCollateral || '0'));
  const hostKey = fc.hostPublicKey || '';
  host.innerHTML =
    '<div class="contract-party-header" style="background:rgba(245,158,11,0.1); color:var(--color-orange);">Host</div>' +
    '<div class="contract-party-body">' +
      '<div>' + truncHash(hostKey.replace('ed25519:', ''), 10) + '</div>' +
      '<div>Host Payout: <span>' + hostPayout + '</span></div>' +
      '<div>Missed: <span>' + missedHost + '</span></div>' +
      '<div>Total Collateral: <span>' + totalColl + '</span></div>' +
    '</div>';

  parties.append(renter, host);
  box.appendChild(parties);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'contract-footer';
  let footerParts =
    '<span>Proof Height: <strong style="color:var(--text-primary);">' + fc.proofHeight.toLocaleString() + '</strong></span>' +
    '<span>Expiration: <strong style="color:var(--text-primary);">' + fc.expirationHeight.toLocaleString() + '</strong></span>' +
    '<span>Filesize: <strong style="color:var(--text-primary);">' + formatFilesize(fc.filesize || 0) + '</strong></span>';
  if (fc.revisionNumber != null) {
    footerParts += '<span>Revision: <strong style="color:var(--text-primary);">' + fc.revisionNumber.toLocaleString() + '</strong></span>';
  }
  const merkleRoot = fc.fileMerkleRoot;
  if (merkleRoot && merkleRoot !== '0'.repeat(64)) {
    footerParts += '<span>Merkle Root: <strong style="color:var(--text-primary);" title="' + merkleRoot + '">' + truncHash(merkleRoot, 10) + '</strong></span>';
  }
  footer.innerHTML = footerParts;
  box.appendChild(footer);

  return box;
}

function buildV1ContractDetail(fc) {
  const box = document.createElement('div');
  box.className = 'detail-grid';

  const validOutputs = fc.validProofOutputs || [];
  const missedOutputs = fc.missedProofOutputs || [];

  let html =
    '<span class="detail-label">Contract ID</span><span class="detail-value">' + truncHash(fc.parentID || '', 12) + '</span>' +
    '<span class="detail-label">Revision</span><span class="detail-value">' + (fc.revisionNumber || 0).toLocaleString() + '</span>' +
    '<span class="detail-label">Filesize</span><span class="detail-value">' + formatFilesize(fc.filesize || 0) + '</span>' +
    '<span class="detail-label">Window</span><span class="detail-value">' + (fc.windowStart || 0).toLocaleString() + ' – ' + (fc.windowEnd || 0).toLocaleString() + '</span>';

  if (validOutputs.length > 0) {
    html += '<span class="detail-label">Valid Proof Outputs</span><span class="detail-value">';
    for (const o of validOutputs) {
      html += '<div>' + formatHastings(BigInt(o.value)) + ' → ' + truncHash(o.address, 8) + '</div>';
    }
    html += '</span>';
  }
  if (missedOutputs.length > 0) {
    html += '<span class="detail-label">Missed Proof Outputs</span><span class="detail-value">';
    for (const o of missedOutputs) {
      html += '<div>' + formatHastings(BigInt(o.value)) + ' → ' + truncHash(o.address, 8) + '</div>';
    }
    html += '</span>';
  }

  box.innerHTML = html;
  return box;
}

function buildResolutionDetail(res) {
  const frag = document.createDocumentFragment();
  const parentContract = res.parent?.v2FileContract;

  // Resolution type badge
  const typeLabel = document.createElement('div');
  typeLabel.style.cssText = 'margin-bottom:0.65rem;';
  const badgeClass = res.type === 'renewal' ? 'badge-green' : res.type === 'storageProof' ? 'badge-blue' : 'badge-orange';
  typeLabel.innerHTML = '<span class="badge ' + badgeClass + '">' + res.type + '</span>';
  frag.appendChild(typeLabel);

  // Parent contract — full detail with ID, all fields, footer
  if (parentContract) {
    frag.appendChild(buildFileContractDetail(parentContract, 'Parent Contract', res.parent?.id));
  }

  // Resolution-specific detail
  if (res.type === 'renewal' && res.resolution) {
    const renewal = res.resolution;

    // New contract — full detail with all fields and footer
    if (renewal.newContract) {
      frag.appendChild(buildFileContractDetail(renewal.newContract, 'New Contract'));
    }

    const details = document.createElement('div');
    details.className = 'detail-grid';
    details.style.marginTop = '0.5rem';
    let html = '';
    if (renewal.finalRenterOutput) {
      html += '<span class="detail-label">Final Renter Output</span><span class="detail-value">' + formatHastings(BigInt(renewal.finalRenterOutput.value)) + '</span>';
    }
    if (renewal.finalHostOutput) {
      html += '<span class="detail-label">Final Host Output</span><span class="detail-value">' + formatHastings(BigInt(renewal.finalHostOutput.value)) + '</span>';
    }
    html += '<span class="detail-label">Renter Rollover</span><span class="detail-value">' + formatHastings(BigInt(renewal.renterRollover || '0')) + '</span>';
    html += '<span class="detail-label">Host Rollover</span><span class="detail-value">' + formatHastings(BigInt(renewal.hostRollover || '0')) + '</span>';
    details.innerHTML = html;
    frag.appendChild(details);
  }

  if (res.type === 'storageProof' && res.resolution) {
    const details = document.createElement('div');
    details.className = 'detail-grid';
    details.style.marginTop = '0.5rem';
    const pi = res.resolution.proofIndex;
    let html = '';
    if (pi?.chainIndex) {
      html += '<span class="detail-label">Proof Index Height</span><span class="detail-value">' + (pi.chainIndex.height || 0).toLocaleString() + '</span>';
    }
    if (parentContract?.renterOutput?.value) {
      html += '<span class="detail-label">Renter Receives</span><span class="detail-value" style="color:var(--color-green);">' + formatHastings(BigInt(parentContract.renterOutput.value)) + '</span>';
    }
    if (parentContract?.hostOutput?.value) {
      html += '<span class="detail-label">Host Receives</span><span class="detail-value" style="color:var(--color-green);">' + formatHastings(BigInt(parentContract.hostOutput.value)) + '</span>';
    }
    details.innerHTML = html;
    frag.appendChild(details);
  }

  if (res.type === 'expiration') {
    const details = document.createElement('div');
    details.className = 'detail-grid';
    details.style.marginTop = '0.5rem';
    let html = '<span class="detail-label" style="color:var(--color-orange);">Outcome</span><span class="detail-value" style="color:var(--color-orange);">Missed proof — host penalized</span>';
    if (parentContract?.renterOutput?.value) {
      html += '<span class="detail-label">Renter Receives</span><span class="detail-value">' + formatHastings(BigInt(parentContract.renterOutput.value)) + '</span>';
    }
    if (parentContract?.missedHostValue != null) {
      html += '<span class="detail-label">Host Receives</span><span class="detail-value" style="color:var(--color-orange);">' + formatHastings(BigInt(parentContract.missedHostValue)) + '</span>';
    }
    details.innerHTML = html;
    frag.appendChild(details);
  }

  return frag;
}

// --- Tab switching ---

function switchTab(tabName) {
  document.querySelectorAll('.exp-tab').forEach(btn => {
    const isActive = btn.dataset.tab === tabName;
    btn.style.background = isActive ? '#151515' : '#0a0a0a';
    btn.style.color = isActive ? '#10b981' : '#888';
    btn.style.borderColor = isActive ? '#2a2a2a' : '#1a1a1a';
    btn.classList.toggle('active', isActive);
  });
  document.getElementById('exp-tab-history').style.display = tabName === 'history' ? '' : 'none';
  document.getElementById('exp-tab-utxos').style.display = tabName === 'utxos' ? '' : 'none';
  document.getElementById('exp-tab-stats').style.display = tabName === 'stats' ? '' : 'none';
}

// --- Table population ---

function populateHistoryTable(utxos) {
  const body = document.getElementById('exp-history-body');
  body.innerHTML = '';
  const sorted = [...utxos].sort((a, b) => (b.height || 0) - (a.height || 0));
  for (const u of sorted) {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #1a1a1a';
    const isRecv = u.direction === 'received';

    const tdHeight = document.createElement('td');
    tdHeight.style.padding = '5px 8px';
    const heightLink = document.createElement('span');
    heightLink.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline;';
    heightLink.textContent = u.height;
    heightLink.onclick = () => { document.getElementById('exp-query').value = u.height; explore(); };
    tdHeight.appendChild(heightLink);

    const tdDir = document.createElement('td');
    tdDir.style.cssText = 'padding:5px 8px; color:' + (isRecv ? '#4ade80' : '#f87171');
    tdDir.textContent = isRecv ? '+' : '-';

    const tdAmt = document.createElement('td');
    tdAmt.style.cssText = 'padding:5px 8px; color:' + (isRecv ? '#4ade80' : '#f87171');
    tdAmt.textContent = u.amount;

    const tdTxid = document.createElement('td');
    tdTxid.style.padding = '5px 8px';
    if (u.txid) {
      const link = document.createElement('span');
      link.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline; font-size:0.75rem;';
      link.textContent = truncateAddr(u.txid);
      link.title = u.txid;
      link.onclick = () => {
        document.getElementById('exp-query').value = u.txid;
        explore();
      };
      tdTxid.appendChild(link);
    } else {
      tdTxid.textContent = u.source === 'miner_payout' ? 'coinbase' : '\u2014';
      tdTxid.style.color = '#888';
      tdTxid.style.fontSize = '0.75rem';
    }

    const tdSrc = document.createElement('td');
    tdSrc.style.cssText = 'padding:5px 8px; color:#888; font-size:0.75rem;';
    tdSrc.textContent = u.source;

    tr.append(tdHeight, tdDir, tdAmt, tdTxid, tdSrc);
    body.appendChild(tr);
  }
}

function populateUtxoTable(utxos) {
  const body = document.getElementById('exp-utxo-body');
  body.innerHTML = '';

  // Compute unspent outputs: received outputs whose outputId isn't consumed by any sent input
  const spentIds = new Set();
  for (const u of utxos) {
    if (u.direction === 'sent' && u.outputId) {
      spentIds.add(u.outputId);
    }
  }
  const unspent = utxos.filter(u => u.direction === 'received' && u.outputId && !spentIds.has(u.outputId) && BigInt(u.amountHastings || '0') > 0n)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  for (const u of unspent) {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #1a1a1a';

    const tdHeight = document.createElement('td');
    tdHeight.style.padding = '5px 8px';
    const heightLink2 = document.createElement('span');
    heightLink2.style.cssText = 'color:#60a5fa; cursor:pointer; text-decoration:underline;';
    heightLink2.textContent = u.height;
    heightLink2.onclick = () => { document.getElementById('exp-query').value = u.height; explore(); };
    tdHeight.appendChild(heightLink2);

    const tdAmt = document.createElement('td');
    tdAmt.style.cssText = 'padding:5px 8px; color:#4ade80;';
    tdAmt.textContent = u.amount;

    const tdId = document.createElement('td');
    tdId.style.cssText = 'padding:5px 8px; font-size:0.75rem; color:#888;';
    tdId.textContent = truncateAddr(u.outputId);
    tdId.title = u.outputId;

    const tdSrc = document.createElement('td');
    tdSrc.style.cssText = 'padding:5px 8px; color:#888; font-size:0.75rem;';
    tdSrc.textContent = u.source;

    tr.append(tdHeight, tdAmt, tdId, tdSrc);
    body.appendChild(tr);
  }

  // Update tab label with count
  const utxoTab = document.querySelector('.exp-tab[data-tab="utxos"]');
  utxoTab.textContent = 'UTXOs (' + unspent.length + ')';
}

function populateStatsTab(result) {
  const el = document.getElementById('exp-tab-stats');
  const utxos = result.utxos || [];
  const tipHeight = result.filterTipHeight + result.tailBlocksScanned;
  const MATURITY_DELAY = 144;

  // Spent IDs set (reuse UTXO logic)
  const spentIds = new Set();
  for (const u of utxos) {
    if (u.direction === 'sent' && u.outputId) spentIds.add(u.outputId);
  }
  const unspent = utxos.filter(u => u.direction === 'received' && u.outputId && !spentIds.has(u.outputId) && BigInt(u.amountHastings || '0') > 0n);

  // Immature outputs (storageproof/contract resolution within maturity window)
  const immatureSources = new Set(['storageproof_host', 'storageproof_renter', 'miner_payout']);
  const immature = unspent.filter(u => immatureSources.has(u.source) && (u.height + MATURITY_DELAY) > tipHeight);
  const immatureTotal = immature.reduce((s, u) => s + BigInt(u.amountHastings), 0n);
  const matureTotal = unspent.reduce((s, u) => s + BigInt(u.amountHastings), 0n) - immatureTotal;

  // Activity range
  const heights = utxos.map(u => u.height);
  const firstHeight = Math.min(...heights);
  const lastHeight = Math.max(...heights);

  // Breakdown by source
  const bySource = {};
  for (const u of utxos) {
    if (!bySource[u.source]) bySource[u.source] = { count: 0, total: 0n };
    bySource[u.source].count++;
    bySource[u.source].total += BigInt(u.amountHastings);
  }

  // Largest inflow/outflow
  let maxRecv = { amount: '0', amountHastings: '0' };
  let maxSent = { amount: '0', amountHastings: '0' };
  for (const u of utxos) {
    if (u.direction === 'received' && BigInt(u.amountHastings) > BigInt(maxRecv.amountHastings)) maxRecv = u;
    if (u.direction === 'sent' && BigInt(u.amountHastings) > BigInt(maxSent.amountHastings)) maxSent = u;
  }

  // Address role detection
  const hostSources = ['renewal_final_host', 'storageproof_host', 'expiration_host'];
  const renterSources = ['renewal_final_renter', 'storageproof_renter', 'expiration_renter'];
  const hostCount = utxos.filter(u => hostSources.includes(u.source)).length;
  const renterCount = utxos.filter(u => renterSources.includes(u.source)).length;
  let role = 'Wallet';
  if (hostCount > 0 && hostCount > renterCount) role = 'Host';
  else if (renterCount > 0) role = 'Renter';

  // Contract stats
  const renewals = utxos.filter(u => u.source.startsWith('renewal_')).length;
  const proofs = utxos.filter(u => u.source.startsWith('storageproof_')).length;
  const expirations = utxos.filter(u => u.source.startsWith('expiration_')).length;

  // Build HTML
  const sc = (hastings) => {
    const n = Number(hastings / 100000000000000000000n);
    return (n / 10000).toFixed(4) + ' SC';
  };

  const row = (label, value, color) =>
    '<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #1a1a1a;">' +
    '<span style="color:#888;">' + label + '</span>' +
    '<span style="color:' + (color || '#e0e0e0') + ';">' + value + '</span></div>';

  let html = '';

  // Role badge
  const roleColor = role === 'Host' ? '#f59e0b' : role === 'Renter' ? '#a78bfa' : '#10b981';
  html += '<div style="margin-bottom:0.75rem;"><span style="background:' + roleColor + '22; color:' + roleColor + '; padding:3px 10px; border-radius:4px; font-size:0.85rem; border:1px solid ' + roleColor + '44;">' + role + '</span></div>';

  // Balance breakdown
  html += '<div style="margin-bottom:0.75rem; font-size:0.85rem; color:#888; font-weight:bold;">Balance</div>';
  html += row('Spendable (mature)', sc(matureTotal), '#4ade80');
  if (immatureTotal > 0n) {
    html += row('Immature (' + immature.length + ' outputs, matures in ' + MATURITY_DELAY + ' blocks)', sc(immatureTotal), '#f59e0b');
  }
  html += row('UTXO count', unspent.length.toLocaleString());
  html += row('Total received', result.receivedSC, '#4ade80');
  html += row('Total sent', result.sentSC, '#f87171');

  // Activity
  html += '<div style="margin:0.75rem 0 0.5rem; font-size:0.85rem; color:#888; font-weight:bold;">Activity</div>';
  const uniqueTxns = new Set(utxos.map(u => u.txid).filter(Boolean));
  html += row('Transactions', uniqueTxns.size.toLocaleString());
  html += row('First active', '<span class="height-link" data-height="' + firstHeight + '" style="color:#60a5fa; cursor:pointer; text-decoration:underline;">' + firstHeight.toLocaleString() + '</span>');
  html += row('Last active', '<span class="height-link" data-height="' + lastHeight + '" style="color:#60a5fa; cursor:pointer; text-decoration:underline;">' + lastHeight.toLocaleString() + '</span>');
  html += row('Span', (lastHeight - firstHeight).toLocaleString() + ' blocks');
  html += row('Largest inflow', maxRecv.amount, '#4ade80');
  html += row('Largest outflow', maxSent.amount, '#f87171');

  // Contract activity
  if (renewals + proofs + expirations > 0) {
    html += '<div style="margin:0.75rem 0 0.5rem; font-size:0.85rem; color:#888; font-weight:bold;">Contracts</div>';
    if (renewals > 0) html += row('Renewals', renewals.toLocaleString());
    if (proofs > 0) html += row('Storage proofs', proofs.toLocaleString());
    if (expirations > 0) html += row('Expirations', expirations.toLocaleString());
  }

  // Source breakdown
  html += '<div style="margin:0.75rem 0 0.5rem; font-size:0.85rem; color:#888; font-weight:bold;">By Source</div>';
  const sourceOrder = Object.keys(bySource).sort((a, b) => bySource[b].count - bySource[a].count);
  for (const src of sourceOrder) {
    const s = bySource[src];
    html += row(src.replace(/_/g, ' '), s.count + ' events / ' + sc(s.total));
  }

  el.innerHTML = html;

  // Make height links clickable
  el.querySelectorAll('.height-link').forEach(link => {
    link.addEventListener('click', () => {
      document.getElementById('exp-query').value = link.dataset.height;
      explore();
    });
  });
}

// --- JSON Export ---

function saveResultAsJson() {
  if (!lastExplorerResult) return;
  const data = {
    address: lastExplorerAddress,
    network: chain.getActiveNetwork(),
    exportedAt: new Date().toISOString(),
    ...lastExplorerResult,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const shortAddr = lastExplorerAddress.slice(0, 12);
  a.download = 'sia-address-' + shortAddr + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

// --- Initialization ---

export function initExplorer() {
  document.getElementById('exp-btn-lookup').addEventListener('click', explore);

  document.getElementById('exp-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') explore();
  });

  document.getElementById('exp-btn-back').addEventListener('click', navigateBack);

  document.getElementById('exp-btn-save-json').addEventListener('click', saveResultAsJson);

  document.querySelectorAll('.exp-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('exp-btn-toggle-json').addEventListener('click', () => {
    const jsonEl = document.getElementById('exp-tx-json');
    const btn = document.getElementById('exp-btn-toggle-json');
    if (jsonEl.style.display === 'none') {
      jsonEl.style.display = 'block';
      btn.textContent = 'Hide Raw JSON';
    } else {
      jsonEl.style.display = 'none';
      btn.textContent = 'Show Raw JSON';
    }
  });

  document.getElementById('exp-btn-clear-log').addEventListener('click', () => {
    document.getElementById('exp-log').innerHTML = '';
  });

  // Subscribe to mempool changes
  chain.onMempoolChange((net, pool) => {
    if (net === chain.getActiveNetwork()) {
      renderMempoolSection();
    }
  });

  // Also update on network change
  chain.onChange(() => renderMempoolSection());

  // Initial render
  renderMempoolSection();
}

// Convert a mempool transaction to the block transaction format used by buildTransactionCard
function mempoolTxnToBlockFormat(txn) {
  return {
    txid: txn.id || '',
    siacoinInputs: (txn.inputs || []).map(inp => ({
      parent: {
        id: inp.outputId || '',
        siacoinOutput: { address: inp.address || '', value: inp.value || '0' },
        maturityHeight: 0,
      },
    })),
    siacoinOutputs: (txn.outputs || []).map(out => ({
      address: out.address || '',
      value: out.value || '0',
    })),
    minerFee: txn.minerFee || '0',
    siafundInputs: [],
    siafundOutputs: [],
    fileContracts: [],
    fileContractRevisions: [],
    fileContractResolutions: [],
    attestations: txn.attestations || [],
  };
}

function renderMempoolSection() {
  const net = chain.getActiveNetwork();
  const txns = chain.getMempoolTransactions(net);
  const countEl = document.getElementById('exp-mempool-count');
  const bodyEl = document.getElementById('exp-mempool-body');
  if (!countEl || !bodyEl) return;

  countEl.textContent = txns.length + ' pending';
  countEl.style.color = txns.length > 0 ? '#f59e0b' : '#888';

  const rebroadcastBtn = document.getElementById('exp-mempool-rebroadcast');
  const clearBtn = document.getElementById('exp-mempool-clear');
  if (rebroadcastBtn) rebroadcastBtn.style.display = txns.length > 0 ? '' : 'none';
  if (clearBtn) clearBtn.style.display = txns.length > 0 ? '' : 'none';

  if (txns.length === 0) {
    bodyEl.innerHTML = '<div style="color:#555; font-size:0.8rem; padding:0.5rem;">No unconfirmed transactions.</div>';
    const statusEl = document.getElementById('exp-mempool-status');
    if (statusEl) statusEl.style.display = 'none';
    return;
  }

  bodyEl.innerHTML = '';
  for (const txn of txns) {
    const blockFmt = mempoolTxnToBlockFormat(txn);
    const card = buildTransactionCard(blockFmt, 0, false);
    card.dataset.txid = txn.id || '';

    // Add unconfirmed badge and age to the header
    const age = Math.round((Date.now() - txn.timestamp) / 1000);
    const ageStr = age < 60 ? age + 's ago' : Math.round(age / 60) + 'm ago';
    const headerRight = card.querySelector('.txn-card-right');
    if (headerRight) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-orange';
      badge.textContent = 'unconfirmed \u23F3 ' + ageStr;
      headerRight.insertBefore(badge, headerRight.firstChild);
    }

    bodyEl.appendChild(card);
  }
}

export function highlightMempoolTxn(txid) {
  const section = document.getElementById('exp-mempool-section');
  if (!section) return;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const card = document.querySelector('#exp-mempool-body .txn-card[data-txid="' + txid + '"]');
  if (!card) return;
  card.classList.add('expanded');
  card.style.borderColor = 'var(--color-accent)';
  setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
}
