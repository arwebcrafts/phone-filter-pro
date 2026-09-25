// ========== API BASE URL ==========
const API_BASE = (window.location.protocol === 'http:' || window.location.protocol === 'https:') && (window.location.port === '3847')
  ? ''
  : 'http://localhost:3847';

// ========== STATE ==========
let currentUpload = null;
let selectedPhoneColumns = new Set();
let currentJobId = null;
let eventSource = null;

// ========== INITIALIZATION ==========
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  loadHistory();
  setupDragAndDrop();
  setupFileInput();
  calculateCost();
});

// ========== NAVIGATION ==========
function switchPage(pageName) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  // Show target page
  const target = document.getElementById(`page-${pageName}`);
  if (target) target.classList.add('active');

  // Update nav tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.page === pageName);
  });

  // Special handling for pages
  if (pageName === 'history') loadHistory();
}

// ========== FILE UPLOAD ==========
function setupDragAndDrop() {
  const zone = document.getElementById('uploadZone');
  
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    zone.addEventListener(evt, e => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  zone.addEventListener('dragenter', () => zone.classList.add('drag-over'));
  zone.addEventListener('dragover', () => zone.classList.add('drag-over'));
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });
}

function setupFileInput() {
  document.getElementById('fileInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) uploadFile(file);
  });
}

async function uploadFile(file) {
  const zone = document.getElementById('uploadZone');
  const ext = file.name.split('.').pop().toLowerCase();
  
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    showToast('Unsupported file format. Please upload CSV, XLSX, or XLS.', 'error');
    return;
  }

  // Show loading state
  zone.querySelector('.upload-title').textContent = 'Uploading...';
  zone.querySelector('.upload-icon').textContent = '⏳';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch(`${API_BASE}/api/upload`, {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Upload failed');
    }

    currentUpload = result;
    showFilePreview(result);
    showToast(`File uploaded! ${result.rowCount.toLocaleString()} rows detected.`, 'success');
    addLog(`📄 File "${result.originalName}" uploaded — ${result.rowCount} rows, ${result.headers.length} columns`);

  } catch (error) {
    showToast(`Upload failed: ${error.message}`, 'error');
    resetUploadZone();
  }
}

function showFilePreview(data) {
  document.getElementById('filePreview').style.display = 'block';
  document.getElementById('uploadZone').style.display = 'none';

  // Stats
  const statsHtml = `
    <div class="stat-item">
      <div class="stat-value">${data.rowCount.toLocaleString()}</div>
      <div class="stat-label">Total Rows</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${data.headers.length}</div>
      <div class="stat-label">Columns</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${data.detectedPhoneCols.length}</div>
      <div class="stat-label">Phone Columns</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${data.originalName.split('.').pop().toUpperCase()}</div>
      <div class="stat-label">File Type</div>
    </div>
  `;
  document.getElementById('fileStats').innerHTML = statsHtml;

  // Preview table
  if (data.sampleData.length > 0) {
    let tableHtml = '<table class="data-table"><thead><tr>';
    data.headers.forEach(h => {
      const isPhone = data.detectedPhoneCols.includes(h);
      tableHtml += `<th style="${isPhone ? 'color: var(--accent-success);' : ''}">${escapeHtml(h)} ${isPhone ? '📞' : ''}</th>`;
    });
    tableHtml += '</tr></thead><tbody>';
    
    data.sampleData.forEach(row => {
      tableHtml += '<tr>';
      data.headers.forEach(h => {
        tableHtml += `<td>${escapeHtml(String(row[h] || ''))}</td>`;
      });
      tableHtml += '</tr>';
    });
    
    tableHtml += '</tbody></table>';
    document.getElementById('previewTable').innerHTML = tableHtml;
  }

  // Column chips
  selectedPhoneColumns = new Set(data.detectedPhoneCols);
  renderColumnChips(data.headers, data.detectedPhoneCols);
  updateSelectedCount();
}

function renderColumnChips(headers, detectedCols) {
  const grid = document.getElementById('columnsGrid');
  grid.innerHTML = headers.map(h => {
    const isDetected = detectedCols.includes(h);
    const isSelected = selectedPhoneColumns.has(h);
    return `
      <div class="column-chip ${isSelected ? 'selected' : ''} ${isDetected ? 'detected' : ''}" 
           onclick="toggleColumn('${escapeAttr(h)}', this)">
        <div class="chip-checkbox"></div>
        <span class="chip-label">${escapeHtml(h)}</span>
      </div>
    `;
  }).join('');
}

function toggleColumn(colName, element) {
  if (selectedPhoneColumns.has(colName)) {
    selectedPhoneColumns.delete(colName);
    element.classList.remove('selected');
  } else {
    selectedPhoneColumns.add(colName);
    element.classList.add('selected');
  }
  updateSelectedCount();
}

function updateSelectedCount() {
  const count = selectedPhoneColumns.size;
  const btn = document.getElementById('startVerifyBtn');
  const countEl = document.getElementById('selectedCount');
  
  btn.disabled = count === 0;
  countEl.textContent = count === 0
    ? 'No columns selected'
    : `${count} column${count > 1 ? 's' : ''} selected`;
}

function resetUpload() {
  currentUpload = null;
  selectedPhoneColumns.clear();
  document.getElementById('filePreview').style.display = 'none';
  resetUploadZone();
  document.getElementById('fileInput').value = '';
}

function resetUploadZone() {
  const zone = document.getElementById('uploadZone');
  zone.style.display = 'block';
  zone.querySelector('.upload-title').textContent = 'Drag & Drop your file here';
  zone.querySelector('.upload-icon').textContent = '📂';
}

// ========== VERIFICATION ==========
async function startVerification() {
  if (!currentUpload || selectedPhoneColumns.size === 0) return;

  // Check API key
  const configResponse = await fetch(`${API_BASE}/api/config`);
  const config = await configResponse.json();
  
  if (!config.hasApiKey) {
    showToast('Please add your API key in Settings first!', 'error');
    switchPage('settings');
    return;
  }

  const countryCode = document.getElementById('countryCode').value.trim();

  // Switch to verify page
  switchPage('verify');
  
  // Show progress panel, hide others
  document.getElementById('progressPanel').classList.add('active');
  document.getElementById('resultsPanel').classList.remove('active');
  document.getElementById('verifyEmpty').style.display = 'none';

  // Reset progress
  updateProgress({ percent: 0, processed: 0, totalRows: currentUpload.rowCount, stats: {} });
  clearLogs();
  addLog(`🚀 Starting verification of ${currentUpload.rowCount} records...`, 'info');
  addLog(`📞 Phone columns: ${[...selectedPhoneColumns].join(', ')}`, 'info');
  if (countryCode) addLog(`🌍 Default country code: ${countryCode}`, 'info');

  try {
    const response = await fetch(`${API_BASE}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: currentUpload.uploadId,
        phoneColumns: [...selectedPhoneColumns],
        countryCode
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Verification failed to start');
    }

    currentJobId = result.jobId;
    addLog(`✅ Job started: ${result.jobId}`, 'success');

    // Connect to SSE for progress updates
    connectSSE(result.jobId);

  } catch (error) {
    showToast(`Failed to start: ${error.message}`, 'error');
    addLog(`❌ Error: ${error.message}`, 'error');
  }
}

function connectSSE(jobId) {
  if (eventSource) eventSource.close();
  
  eventSource = new EventSource(`${API_BASE}/api/progress/${jobId}`);
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    switch (data.type) {
      case 'start':
        addLog(`📡 Connected — processing ${data.totalRows} records...`, 'info');
        break;
      
      case 'progress':
        updateProgress(data);
        if (data.processed % 50 === 0 || data.processed === data.totalRows) {
          addLog(`📊 ${data.processed}/${data.totalRows} processed (${data.percent}%)`, 'info');
        }
        break;
      
      case 'complete':
        updateProgress(data);
        showResults(data);
        addLog(`🎉 Verification complete! ${data.processed} records processed.`, 'success');
        showToast('Verification complete! 🎉', 'success');
        eventSource.close();
        eventSource = null;
        break;
      
      case 'error':
        addLog(`❌ Error: ${data.message}`, 'error');
        showToast(`Error: ${data.message}`, 'error');
        eventSource.close();
        eventSource = null;
        break;
    }
  };

  eventSource.onerror = () => {
    addLog('⚠️ Connection lost. Results may still be processing...', 'error');
  };
}

function updateProgress(data) {
  const { percent = 0, processed = 0, totalRows = 0, stats = {} } = data;
  
  document.getElementById('progressBar').style.width = `${percent}%`;
  document.getElementById('progressPercent').textContent = `${percent}%`;
  document.getElementById('progressCount').textContent = `${processed.toLocaleString()} / ${totalRows.toLocaleString()}`;
  document.getElementById('progressMessage').textContent = data.message || 'Processing...';
  
  document.getElementById('statMobile').textContent = stats.mobile || 0;
  document.getElementById('statLandline').textContent = stats.landline || 0;
  document.getElementById('statVoip').textContent = (stats.voip || 0) + (stats.fixed_voip || 0);
  document.getElementById('statInvalid').textContent = stats.invalid || 0;
  document.getElementById('statProcessed').textContent = processed.toLocaleString();
}

function showResults(data) {
  const { stats = {}, outputFiles = {}, autoSavePath, totalRows } = data;
  
  // Hide progress, show results
  document.getElementById('progressPanel').classList.remove('active');
  document.getElementById('resultsPanel').classList.add('active');
  
  document.getElementById('resultsSubtitle').textContent = 
    `Successfully processed ${totalRows.toLocaleString()} records. Here's the breakdown:`;

  // Summary cards
  const total = totalRows;
  const summaryData = [
    { icon: '📱', label: 'Mobile', value: stats.mobile || 0, class: 'mobile' },
    { icon: '☎️', label: 'Landline', value: stats.landline || 0, class: 'landline' },
    { icon: '🌐', label: 'VoIP', value: (stats.voip || 0) + (stats.fixed_voip || 0), class: 'voip' },
    { icon: '❌', label: 'Invalid', value: stats.invalid || 0, class: 'invalid' },
    { icon: '✅', label: 'Total Verified', value: total, class: 'total' }
  ];

  document.getElementById('resultsSummary').innerHTML = summaryData.map(s => `
    <div class="summary-card ${s.class}">
      <div class="summary-icon">${s.icon}</div>
      <div class="summary-value">${s.value.toLocaleString()}</div>
      <div class="summary-label">${s.label}</div>
      <div class="summary-percent">${total > 0 ? ((s.value / total) * 100).toFixed(1) : 0}%</div>
    </div>
  `).join('');

  // Filtered download buttons
  const downloadConfigs = [
    { key: 'MOBILE', icon: '📱', label: 'Mobile Only', btnClass: 'btn-primary' },
    { key: 'LANDLINE', icon: '☎️', label: 'Landline Only', btnClass: 'btn-ghost' },
    { key: 'VOIP', icon: '🌐', label: 'VoIP Only', btnClass: 'btn-ghost' },
    { key: 'VALID', icon: '✅', label: 'All Valid', btnClass: 'btn-ghost' },
    { key: 'INVALID', icon: '❌', label: 'Invalid', btnClass: 'btn-ghost' },
    { key: 'ALL', icon: '📄', label: 'All Data', btnClass: 'btn-ghost' }
  ];

  let downloadHtml = '';
  for (const dc of downloadConfigs) {
    const fileInfo = outputFiles[dc.key];
    if (fileInfo && fileInfo.fileName && fileInfo.count > 0) {
      const isPrimary = dc.key === 'MOBILE';
      const sizeClass = isPrimary ? 'btn-lg' : '';
      downloadHtml += `
        <a href="${API_BASE}/api/download/${fileInfo.fileName}" class="btn ${dc.btnClass} ${sizeClass}" download>
          <span class="btn-icon">${dc.icon}</span> ${dc.label} (${fileInfo.count.toLocaleString()})
        </a>
      `;
    }
  }

  downloadHtml += `
    <button class="btn btn-ghost" onclick="switchPage('upload'); resetUpload();" style="margin-left: auto;">
      <span class="btn-icon">📤</span> Upload Another File
    </button>
  `;

  document.getElementById('downloadActions').innerHTML = downloadHtml;

  // Auto-save banner
  if (autoSavePath) {
    document.getElementById('saveBanner').style.display = 'flex';
    document.getElementById('savePath').textContent = autoSavePath;
  }
}

// ========== SETTINGS ==========
async function loadConfig() {
  try {
    const response = await fetch(`${API_BASE}/api/config`);
    const config = await response.json();
    
    if (config.apiProvider) {
      document.getElementById('settingProvider').value = config.apiProvider;
    }

    const badgeVeriphone = document.getElementById('badgeVeriphoneKey');
    const badgePhonevalidator = document.getElementById('badgePhonevalidatorKey');

    if (config.hasVeriphoneKey) {
      document.getElementById('settingVeriphoneKey').value = config.veriphoneKeyMasked;
      if (badgeVeriphone) {
        badgeVeriphone.textContent = 'Configured ✅';
        badgeVeriphone.style.background = 'rgba(16,185,129,0.15)';
        badgeVeriphone.style.color = '#10B981';
      }
    } else {
      document.getElementById('settingVeriphoneKey').value = '';
      if (badgeVeriphone) {
        badgeVeriphone.textContent = 'Not Set ⚠️';
        badgeVeriphone.style.background = 'rgba(239,68,68,0.15)';
        badgeVeriphone.style.color = '#EF4444';
      }
    }

    if (config.hasPhonevalidatorKey) {
      document.getElementById('settingPhonevalidatorKey').value = config.phonevalidatorKeyMasked;
      if (badgePhonevalidator) {
        badgePhonevalidator.textContent = 'Configured ✅';
        badgePhonevalidator.style.background = 'rgba(16,185,129,0.15)';
        badgePhonevalidator.style.color = '#10B981';
      }
    } else {
      document.getElementById('settingPhonevalidatorKey').value = '';
      if (badgePhonevalidator) {
        badgePhonevalidator.textContent = 'Not Set ⚠️';
        badgePhonevalidator.style.background = 'rgba(239,68,68,0.15)';
        badgePhonevalidator.style.color = '#EF4444';
      }
    }

    // Header status pill
    const activeProviderName = config.apiProvider === 'phonevalidator' ? 'PhoneValidator' : 'Veriphone';
    if (config.hasApiKey) {
      document.getElementById('statusDot').classList.remove('disconnected');
      document.getElementById('statusText').textContent = `${activeProviderName} Active ✅`;
    } else {
      document.getElementById('statusDot').classList.add('disconnected');
      document.getElementById('statusText').textContent = `${activeProviderName} (No Key)`;
    }

    calculateCost();
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

function onProviderChange() {
  calculateCost();
}

async function saveSettings() {
  const veriphoneKey = document.getElementById('settingVeriphoneKey').value.trim();
  const phonevalidatorKey = document.getElementById('settingPhonevalidatorKey').value.trim();
  const apiProvider = document.getElementById('settingProvider').value;

  const body = { apiProvider };
  if (veriphoneKey && !veriphoneKey.includes('*')) {
    body.veriphoneApiKey = veriphoneKey;
  }
  if (phonevalidatorKey && !phonevalidatorKey.includes('*')) {
    body.phonevalidatorApiKey = phonevalidatorKey;
  }

  try {
    const response = await fetch(`${API_BASE}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const result = await response.json();
    
    if (result.success) {
      showToast('Settings saved successfully!', 'success');
      loadConfig(); // Refresh display
    }
  } catch (error) {
    showToast(`Failed to save: ${error.message}`, 'error');
  }
}

function calculateCost() {
  const leads = parseInt(document.getElementById('costLeads').value) || 0;
  const provider = document.getElementById('settingProvider').value;

  // Veriphone uses credit packs — find the best-fit pack
  if (provider === 'veriphone') {
    const packs = [
      { credits: 10000, price: 24, perK: 2.40 },
      { credits: 25000, price: 49, perK: 1.96 },
      { credits: 50000, price: 79, perK: 1.58 },
      { credits: 100000, price: 119, perK: 1.19 },
      { credits: 250000, price: 199, perK: 0.80 },
      { credits: 500000, price: 299, perK: 0.60 },
      { credits: 1000000, price: 399, perK: 0.40 },
      { credits: 2500000, price: 699, perK: 0.28 },
      { credits: 5000000, price: 999, perK: 0.20 }
    ];

    // Find cheapest combination of packs
    let bestPack = packs[0];
    let totalCost = 0;
    let packDesc = '';

    // Find smallest single pack that covers the leads
    const singlePack = packs.find(p => p.credits >= leads);
    if (singlePack) {
      bestPack = singlePack;
      totalCost = singlePack.price;
      packDesc = `${singlePack.credits.toLocaleString()} credit pack (${(singlePack.credits - leads).toLocaleString()} credits leftover)`;
    } else {
      // Need multiple packs — use largest packs first
      let remaining = leads;
      let parts = [];
      for (let i = packs.length - 1; i >= 0 && remaining > 0; i--) {
        const count = Math.floor(remaining / packs[i].credits);
        if (count > 0) {
          totalCost += count * packs[i].price;
          remaining -= count * packs[i].credits;
          parts.push(`${count}× ${packs[i].credits.toLocaleString()}`);
        }
      }
      if (remaining > 0) {
        const coverPack = packs.find(p => p.credits >= remaining) || packs[0];
        totalCost += coverPack.price;
        parts.push(`1× ${coverPack.credits.toLocaleString()}`);
      }
      packDesc = parts.join(' + ');
    }

    document.getElementById('costResult').innerHTML = `
      <div style="padding: 16px; background: var(--bg-surface); border-radius: var(--radius-md); border: 1px solid var(--border-subtle);">
        <div style="font-size: 28px; font-weight: 800; background: var(--gradient-primary); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">$${totalCost}</div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
          ${leads.toLocaleString()} leads via Veriphone (Standard Validation)
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">
          💡 Best pack: ${packDesc}
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-subtle);">
          ⚠️ Current Carrier Lookup uses 10 credits per lookup → cost would be ~$${(totalCost * 10)} for ${leads.toLocaleString()} leads
        </div>
      </div>
    `;
    return;
  }

  // Other providers — flat rate
  const rates = {
    phonevalidator: { rate: 0.004, name: 'PhoneValidator.com (Includes Ported Carrier Detection)' },
    telnyx: { rate: 0.004, name: 'Telnyx' },
    twilio: { rate: 0.008, name: 'Twilio' },
    numverify: { rate: 0.003, name: 'NumVerify' },
    abstractapi: { rate: 0.002, name: 'AbstractAPI' }
  };

  const info = rates[provider] || { rate: 0.004, name: provider };
  const cost = (leads * info.rate).toFixed(2);
  
  document.getElementById('costResult').innerHTML = `
    <div style="padding: 16px; background: var(--bg-surface); border-radius: var(--radius-md); border: 1px solid var(--border-subtle);">
      <div style="font-size: 28px; font-weight: 800; background: var(--gradient-primary); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">$${cost}</div>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
        ${leads.toLocaleString()} leads × $${info.rate}/lookup via ${info.name}
      </div>
    </div>
  `;
}

// ========== HISTORY ==========
async function loadHistory() {
  try {
    const response = await fetch(`${API_BASE}/api/history`);
    const data = await response.json();
    const list = document.getElementById('historyList');

    if (data.jobs && data.jobs.length > 0) {
      list.innerHTML = data.jobs.map(job => {
        const stats = job.stats || {};
        const files = job.outputFiles || {};
        
        const providerName = job.apiProvider === 'phonevalidator' ? 'PhoneValidator.com' : (job.apiProvider === 'veriphone' ? 'Veriphone.io' : (job.apiProvider || 'Veriphone.io'));
        const providerBadgeColor = job.apiProvider === 'phonevalidator' ? '#3B82F6' : '#8B5CF6';
        const providerBadgeBg = job.apiProvider === 'phonevalidator' ? 'rgba(59,130,246,0.15)' : 'rgba(139,92,246,0.15)';

        const downloadConfigs = [
          { key: 'MOBILE', icon: '📱', label: 'Mobile Only', btnClass: 'btn-primary' },
          { key: 'LANDLINE', icon: '☎️', label: 'Landline Only', btnClass: 'btn-ghost' },
          { key: 'VOIP', icon: '🌐', label: 'VoIP Only', btnClass: 'btn-ghost' },
          { key: 'VALID', icon: '✅', label: 'All Valid', btnClass: 'btn-ghost' },
          { key: 'INVALID', icon: '❌', label: 'Invalid', btnClass: 'btn-ghost' },
          { key: 'ALL', icon: '📄', label: 'All Data', btnClass: 'btn-ghost' }
        ];

        let buttonsHtml = '';
        for (const dc of downloadConfigs) {
          const fInfo = files[dc.key];
          if (fInfo && fInfo.fileName && fInfo.count > 0) {
            buttonsHtml += `
              <a href="${API_BASE}/api/download/${encodeURIComponent(fInfo.fileName)}" class="btn ${dc.btnClass} btn-sm" download style="margin-right: 6px; margin-top: 6px;">
                <span class="btn-icon">${dc.icon}</span> ${dc.label} (${fInfo.count.toLocaleString()})
              </a>
            `;
          }
        }

        return `
          <div class="card" style="margin-bottom: 20px;">
            <div class="card-header" style="padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle);">
              <div>
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  <h3 class="card-title" style="font-size: 16px; font-weight: 700;">📄 ${escapeHtml(job.originalName)}</h3>
                  <span class="format-badge" style="background: ${providerBadgeBg}; color: ${providerBadgeColor}; font-size: 11px; font-weight: 600;">⚡ Provider: ${providerName}</span>
                </div>
                <span style="font-size: 12px; color: var(--text-muted);">${formatDate(job.timestamp)} • ${job.totalRows.toLocaleString()} total rows</span>
              </div>
            </div>
            
            <div style="display: flex; gap: 12px; flex-wrap: wrap; margin: 12px 0;">
              <span class="format-badge" style="background: rgba(16,185,129,0.15); color: #10B981;">📱 Mobile: ${stats.mobile || 0}</span>
              <span class="format-badge" style="background: rgba(59,130,246,0.15); color: #3B82F6;">☎️ Landline: ${stats.landline || 0}</span>
              <span class="format-badge" style="background: rgba(139,92,246,0.15); color: #8B5CF6;">🌐 VoIP: ${stats.voip || 0}</span>
              <span class="format-badge" style="background: rgba(239,68,68,0.15); color: #EF4444;">❌ Invalid: ${stats.invalid || 0}</span>
            </div>

            <div style="display: flex; flex-wrap: wrap; margin-top: 10px;">
              ${buttonsHtml}
            </div>
          </div>
        `;
      }).join('');
      return;
    }

    // Fallback: list output files if no job metadata exists
    const filesRes = await fetch(`${API_BASE}/api/outputs`);
    const filesData = await filesRes.json();
    
    if (!filesData.files || filesData.files.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📁</div>
          <h3 class="empty-state-title">No files yet</h3>
          <p class="empty-state-desc">Verified files will appear here after processing.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = filesData.files.map(f => `
      <div class="history-item">
        <div class="history-info">
          <span class="history-icon">📄</span>
          <div>
            <div class="history-name">${escapeHtml(f.name)}</div>
            <div class="history-meta">${formatFileSize(f.size)} • ${formatDate(f.created)}</div>
          </div>
        </div>
        <a href="${API_BASE}/api/download/${encodeURIComponent(f.name)}" class="btn btn-ghost btn-sm" download>
          <span class="btn-icon">📥</span> Download
        </a>
      </div>
    `).join('');
  } catch (error) {
    console.error('Failed to load history:', error);
  }
}

// ========== LOGGING ==========
function addLog(message, type = 'info') {
  const logArea = document.getElementById('logArea');
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = `<span class="time">[${time}]</span> ${escapeHtml(message)}`;
  logArea.appendChild(entry);
  logArea.scrollTop = logArea.scrollHeight;
}

function clearLogs() {
  document.getElementById('logArea').innerHTML = '';
}

// ========== TOASTS ==========
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span> ${escapeHtml(message)}`;
  container.appendChild(toast);
  
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 5000);
}

// ========== UTILITIES ==========
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}
