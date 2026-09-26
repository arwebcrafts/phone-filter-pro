const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = 3847;

// Directories
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Ensure directories exist safely (catch read-only filesystem errors on Vercel)
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // Read-only filesystem on Vercel serverless environment
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Multer setup for file uploads (memory storage for Vercel compatibility)
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.csv', '.xlsx', '.xls'];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Please upload CSV, XLSX, or XLS files.`));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

// Memory stores for Vercel serverless deployment
const uploadStore = new Map();
const jobResultsStore = new Map();      // jobId -> { outputFiles: { MOBILE: Buffer, ... } }
const downloadStore = new Map();         // fileName -> { buffer, mimeType }

// ========== MULTI-KEY POOL CONFIG ==========
// config.veriphoneKeys = [ { key: '...', label: 'Gmail 1', credits: 1000 }, ... ]
// config.phonevalidatorKeys = [ { key: '...', label: 'Account 1', credits: null }, ... ]
let config = {
  apiProvider: process.env.API_PROVIDER || 'veriphone',
  veriphoneApiKey: process.env.VERIPHONE_API_KEY || process.env.API_KEY || '',
  phonevalidatorApiKey: process.env.PHONEVALIDATOR_API_KEY || '',
  apiKey: process.env.API_KEY || '',
  veriphoneKeys: [],      // Array of { key, label, credits, lastChecked }
  phonevalidatorKeys: []  // Array of { key, label }
};

// Load config from file if exists
const CONFIG_FILE = path.join(__dirname, 'config.json');
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...loaded };
    // Ensure arrays exist
    if (!Array.isArray(config.veriphoneKeys)) config.veriphoneKeys = [];
    if (!Array.isArray(config.phonevalidatorKeys)) config.phonevalidatorKeys = [];
  } catch (e) {
    console.log('Could not load config, using defaults');
  }
}

// Migrate legacy single key to pool if pool is empty
function migrateLegacyKeys() {
  if (config.veriphoneApiKey && config.veriphoneKeys.length === 0) {
    config.veriphoneKeys.push({ key: config.veriphoneApiKey, label: 'Default Key', credits: null, lastChecked: null });
  }
  if (config.phonevalidatorApiKey && config.phonevalidatorKeys.length === 0) {
    config.phonevalidatorKeys.push({ key: config.phonevalidatorApiKey, label: 'Default Key' });
  }
}
migrateLegacyKeys();

// Get best available key (one with most credits for Veriphone)
function getActiveApiKey(provider) {
  const p = provider || config.apiProvider;
  if (p === 'phonevalidator') {
    const keys = config.phonevalidatorKeys || [];
    if (keys.length > 0) return keys[0].key;
    return config.phonevalidatorApiKey || config.apiKey || '';
  }
  // Veriphone: pick key with highest credits > 0
  const keys = config.veriphoneKeys || [];
  if (keys.length > 0) {
    // Prefer keys with known credits > 0, then keys with unknown credits (null)
    const withCredits = keys.filter(k => k.credits > 0).sort((a, b) => b.credits - a.credits);
    if (withCredits.length > 0) return withCredits[0].key;
    const unknown = keys.filter(k => k.credits === null || k.credits === undefined);
    if (unknown.length > 0) return unknown[0].key;
    // All exhausted — return first anyway (API will error)
    return keys[0].key;
  }
  return config.veriphoneApiKey || config.apiKey || '';
}

// Get next key with credits for rotation during batch processing
function getNextVeriphoneKey(exhaustedKey) {
  const keys = config.veriphoneKeys || [];
  // Mark exhausted key as 0 credits
  const exhausted = keys.find(k => k.key === exhaustedKey);
  if (exhausted) exhausted.credits = 0;
  // Find next with credits
  const available = keys.filter(k => k.credits === null || k.credits > 0);
  return available.length > 0 ? available[0].key : null;
}

// Save config
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {}
}

// SSE connections for progress updates
const sseClients = new Map();

// ========== ROUTES ==========

// Config endpoints
app.get('/api/config', (req, res) => {
  function maskKey(key) {
    if (!key) return '';
    return `${key.slice(0, 4)}${'*'.repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`;
  }

  const activeKey = getActiveApiKey(config.apiProvider);

  // Mask keys in pool arrays
  const maskedVeriphoneKeys = (config.veriphoneKeys || []).map((k, i) => ({
    index: i,
    label: k.label || `Key ${i + 1}`,
    keyMasked: maskKey(k.key),
    credits: k.credits,
    lastChecked: k.lastChecked
  }));

  const maskedPhonevalidatorKeys = (config.phonevalidatorKeys || []).map((k, i) => ({
    index: i,
    label: k.label || `Key ${i + 1}`,
    keyMasked: maskKey(k.key)
  }));

  res.json({
    apiProvider: config.apiProvider,
    hasApiKey: !!activeKey,
    apiKeyMasked: maskKey(activeKey),
    hasVeriphoneKey: config.veriphoneKeys.length > 0 || !!config.veriphoneApiKey,
    hasPhonevalidatorKey: config.phonevalidatorKeys.length > 0 || !!config.phonevalidatorApiKey,
    veriphoneKeys: maskedVeriphoneKeys,
    phonevalidatorKeys: maskedPhonevalidatorKeys,
    totalVeriphoneCredits: (config.veriphoneKeys || []).reduce((sum, k) => sum + (k.credits || 0), 0),
    isVercel: !!process.env.VERCEL
  });
});

app.post('/api/config', (req, res) => {
  const { apiProvider, veriphoneApiKey, phonevalidatorApiKey } = req.body;
  if (apiProvider !== undefined) config.apiProvider = apiProvider;
  
  // Legacy single key support
  if (veriphoneApiKey !== undefined && !veriphoneApiKey.includes('*')) {
    config.veriphoneApiKey = veriphoneApiKey;
  }
  if (phonevalidatorApiKey !== undefined && !phonevalidatorApiKey.includes('*')) {
    config.phonevalidatorApiKey = phonevalidatorApiKey;
  }
  
  saveConfig();
  const isVercel = !!process.env.VERCEL;
  res.json({ 
    success: true, 
    message: isVercel 
      ? 'Settings saved for this session! For permanent keys on Vercel, set VERIPHONE_API_KEY and PHONEVALIDATOR_API_KEY in your Vercel Environment Variables.'
      : 'Configuration saved!'
  });
});

// ========== KEY POOL MANAGEMENT ==========

// Add a new key to the pool
app.post('/api/keys/add', async (req, res) => {
  const { provider, key, label } = req.body;
  if (!key || !key.trim()) {
    return res.status(400).json({ error: 'API key is required' });
  }

  const trimmedKey = key.trim();
  
  if (provider === 'phonevalidator') {
    // Check for duplicates
    if (config.phonevalidatorKeys.some(k => k.key === trimmedKey)) {
      return res.status(400).json({ error: 'This key already exists in your pool' });
    }
    config.phonevalidatorKeys.push({ key: trimmedKey, label: label || `PV Key ${config.phonevalidatorKeys.length + 1}` });
    if (!config.phonevalidatorApiKey) config.phonevalidatorApiKey = trimmedKey;
    saveConfig();
    return res.json({ success: true, message: 'PhoneValidator key added!', totalKeys: config.phonevalidatorKeys.length });
  }

  // Veriphone — check for duplicates
  if (config.veriphoneKeys.some(k => k.key === trimmedKey)) {
    return res.status(400).json({ error: 'This key already exists in your pool' });
  }

  // Try to check credits immediately
  let credits = null;
  try {
    credits = await checkVeriphoneCredits(trimmedKey);
  } catch (e) {
    // Key might still be valid, just can't check credits
  }

  config.veriphoneKeys.push({ 
    key: trimmedKey, 
    label: label || `Veriphone Key ${config.veriphoneKeys.length + 1}`, 
    credits, 
    lastChecked: new Date().toISOString() 
  });
  if (!config.veriphoneApiKey) config.veriphoneApiKey = trimmedKey;
  saveConfig();

  res.json({ 
    success: true, 
    message: `Veriphone key added! ${credits !== null ? credits + ' credits available' : 'Credits unknown'}`, 
    credits,
    totalKeys: config.veriphoneKeys.length
  });
});

// Remove a key from the pool
app.post('/api/keys/remove', (req, res) => {
  const { provider, index } = req.body;
  
  if (provider === 'phonevalidator') {
    if (index >= 0 && index < config.phonevalidatorKeys.length) {
      config.phonevalidatorKeys.splice(index, 1);
      saveConfig();
      return res.json({ success: true, message: 'Key removed', totalKeys: config.phonevalidatorKeys.length });
    }
  } else {
    if (index >= 0 && index < config.veriphoneKeys.length) {
      config.veriphoneKeys.splice(index, 1);
      saveConfig();
      return res.json({ success: true, message: 'Key removed', totalKeys: config.veriphoneKeys.length });
    }
  }
  res.status(400).json({ error: 'Invalid key index' });
});

// Check credits for all Veriphone keys
app.post('/api/keys/check-credits', async (req, res) => {
  const results = [];
  for (const entry of config.veriphoneKeys) {
    try {
      const credits = await checkVeriphoneCredits(entry.key);
      entry.credits = credits;
      entry.lastChecked = new Date().toISOString();
      results.push({ label: entry.label, credits, status: 'ok' });
    } catch (e) {
      results.push({ label: entry.label, credits: entry.credits, status: `error: ${e.message}` });
    }
  }
  saveConfig();
  
  const totalCredits = config.veriphoneKeys.reduce((sum, k) => sum + (k.credits || 0), 0);
  res.json({ 
    success: true, 
    results, 
    totalCredits,
    message: `Total pool: ${totalCredits.toLocaleString()} credits across ${config.veriphoneKeys.length} keys`
  });
});

// Check Veriphone credits for a single key
async function checkVeriphoneCredits(apiKey) {
  try {
    const url = `https://api.veriphone.io/v2/verify?phone=+14155552671&key=${apiKey}`;
    const response = await fetch(url);
    
    // The response headers or body contain credit info
    // Veriphone returns remaining_credits in response
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }
    
    const result = await response.json();
    // Veriphone v2 returns remaining_credits in the response
    if (result.remaining_credits !== undefined) {
      return result.remaining_credits;
    }
    
    // Fallback: try v3 credits endpoint
    try {
      const creditsUrl = `https://api.veriphone.io/v3/credits`;
      const creditsRes = await fetch(creditsUrl, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
      });
      if (creditsRes.ok) {
        const creditsData = await creditsRes.json();
        return creditsData.counter || creditsData.remaining_credits || null;
      }
    } catch (e) {}
    
    return null;
  } catch (error) {
    throw error;
  }
}

// File upload and parsing
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse the file from buffer or path
    const workbook = req.file.buffer 
      ? XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true })
      : XLSX.readFile(req.file.path, { type: 'file', cellDates: true });

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (data.length === 0) {
      return res.status(400).json({ error: 'File is empty or has no data rows' });
    }

    const headers = Object.keys(data[0]);
    
    // Auto-detect phone columns
    const phonePatterns = /phone|mobile|cell|tel|contact.*num|fax|whatsapp|sms|call/i;
    const detectedPhoneCols = headers.filter(h => phonePatterns.test(h));

    // Store upload info for later processing
    const uploadId = Date.now().toString();
    const uploadInfo = {
      id: uploadId,
      originalName: req.file.originalname,
      headers,
      rowCount: data.length,
      detectedPhoneCols,
      sampleData: data.slice(0, 5),
      data, // parsed data stored in memory
      allSheets: workbook.SheetNames
    };

    uploadStore.set(uploadId, uploadInfo);

    res.json({
      success: true,
      uploadId,
      originalName: req.file.originalname,
      headers,
      rowCount: data.length,
      detectedPhoneCols,
      sampleData: data.slice(0, 5),
      allSheets: workbook.SheetNames
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: `Failed to parse file: ${error.message}` });
  }
});

// SSE endpoint for progress
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  sseClients.set(jobId, res);

  req.on('close', () => {
    sseClients.delete(jobId);
  });
});

function sendProgress(jobId, data) {
  const client = sseClients.get(jobId);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// Helper: Robust phone number formatter
function formatPhoneNumber(phone, userCountryCode) {
  let str = String(phone).trim();
  if (!str) return '';

  let hasPlus = str.startsWith('+');
  let digitsOnly = str.replace(/[^\d]/g, '');

  if (!digitsOnly) return '';

  if (str.startsWith('00')) {
    hasPlus = true;
  }

  if (hasPlus) {
    return '+' + digitsOnly;
  }

  // 10-digit standard US/Canada number
  if (digitsOnly.length === 10) {
    let cc = (userCountryCode || '+1').trim();
    if (!cc.startsWith('+')) cc = '+' + cc;
    return `${cc}${digitsOnly}`;
  }

  // 11-digit US/Canada number starting with 1
  if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    return '+' + digitsOnly;
  }

  let cc = (userCountryCode || '+1').trim();
  if (!cc.startsWith('+')) cc = '+' + cc;
  return `${cc}${digitsOnly}`;
}

// Phone verification using Veriphone API
async function verifyPhoneVeriphone(phone, apiKey) {
  const cleanPhone = String(phone).replace(/[^+\d]/g, '');
  if (!cleanPhone || cleanPhone.length < 7) {
    return {
      phone_valid: false,
      phone_line_type: 'unknown',
      phone_carrier: '',
      phone_country: '',
      phone_international_format: cleanPhone,
      verification_status: 'invalid_format'
    };
  }

  try {
    const url = `https://api.veriphone.io/v2/verify?phone=${encodeURIComponent(cleanPhone)}&key=${apiKey}`;
    const response = await fetch(url);
    
    if (response.status === 429) {
      await sleep(2000);
      return verifyPhoneVeriphone(phone, apiKey);
    }
    
    if (!response.ok) {
      const errorText = await response.text();
      // Check if it's a credits exhausted error
      if (response.status === 402 || errorText.includes('credits') || errorText.includes('limit')) {
        // Mark this key as exhausted and try next
        const nextKey = getNextVeriphoneKey(apiKey);
        if (nextKey) {
          return verifyPhoneVeriphone(phone, nextKey);
        }
      }
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    
    // Update credits for this key if returned
    if (result.remaining_credits !== undefined) {
      const keyEntry = (config.veriphoneKeys || []).find(k => k.key === apiKey);
      if (keyEntry) {
        keyEntry.credits = result.remaining_credits;
        keyEntry.lastChecked = new Date().toISOString();
      }
    }
    
    return {
      phone_valid: result.phone_valid || false,
      phone_line_type: result.phone_type || 'unknown',
      phone_carrier: result.carrier || '',
      phone_country: result.country || '',
      phone_country_code: result.country_code || '',
      phone_international_format: result.international_number || cleanPhone,
      phone_local_format: result.local_number || '',
      phone_e164_format: result.e164 || '',
      verification_status: result.phone_valid ? 'verified' : 'invalid'
    };
  } catch (error) {
    return {
      phone_valid: false,
      phone_line_type: 'error',
      phone_carrier: '',
      phone_country: '',
      phone_country_code: '',
      phone_international_format: cleanPhone,
      phone_local_format: '',
      phone_e164_format: '',
      verification_status: `error: ${error.message}`
    };
  }
}

// Phone verification using PhoneValidator.com V4 API
async function verifyPhonePhoneValidator(phone, apiKey) {
  const cleanPhone = String(phone).replace(/[^+\d]/g, '');
  if (!cleanPhone || cleanPhone.length < 7) {
    return {
      phone_valid: false,
      phone_line_type: 'unknown',
      phone_carrier: '',
      phone_country: '',
      phone_international_format: cleanPhone,
      verification_status: 'invalid_format'
    };
  }

  try {
    // region=2 specifies US & Canada Only lookup in PhoneValidator V4 API
    const url = `https://api.phonevalidator.com/api/v4/phonesearch?apikey=${encodeURIComponent(apiKey)}&phone=${encodeURIComponent(cleanPhone)}&type=basic&region=2`;
    const response = await fetch(url);
    
    if (response.status === 429) {
      await sleep(1000);
      return verifyPhonePhoneValidator(phone, apiKey);
    }
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    
    if (result.StatusCode === '429') {
      await sleep(1000);
      return verifyPhonePhoneValidator(phone, apiKey);
    }

    if (result.StatusCode && result.StatusCode !== '200') {
      return {
        phone_valid: false,
        phone_line_type: 'error',
        phone_carrier: '',
        phone_country: '',
        phone_country_code: '',
        phone_international_format: cleanPhone,
        phone_local_format: '',
        phone_e164_format: '',
        verification_status: `API Error ${result.StatusCode}: ${result.StatusMessage || 'Unknown'}`
      };
    }

    const basic = result.PhoneBasic || {};
    const rawLineType = (basic.LineType || '').toUpperCase();
    let lineType = 'unknown';
    
    if (rawLineType.includes('CELL') || rawLineType.includes('MOBILE')) lineType = 'mobile';
    else if (rawLineType.includes('LANDLINE') || rawLineType.includes('FIXED')) lineType = 'landline';
    else if (rawLineType.includes('VOIP')) lineType = 'voip';
    else if (rawLineType.includes('TOLL')) lineType = 'toll_free';

    const isFake = basic.FakeNumber === 'YES';
    const isValid = !isFake && lineType !== 'unknown' && !basic.ErrorCode;

    return {
      phone_valid: isValid,
      phone_line_type: lineType,
      phone_carrier: basic.PhoneCompany || '',
      phone_country: basic.Country || '',
      phone_country_code: basic.CountryCode || '',
      phone_location: basic.PhoneLocation || '',
      phone_international_format: cleanPhone,
      phone_local_format: '',
      phone_e164_format: cleanPhone,
      verification_status: isValid ? 'verified' : (isFake ? `fake: ${basic.FakeNumberReason || 'Fake number'}` : 'invalid')
    };
  } catch (error) {
    return {
      phone_valid: false,
      phone_line_type: 'error',
      phone_carrier: '',
      phone_country: '',
      phone_country_code: '',
      phone_international_format: cleanPhone,
      phone_local_format: '',
      phone_e164_format: '',
      verification_status: `error: ${error.message}`
    };
  }
}

// Master verification router
async function verifyPhone(phone, apiKey, provider) {
  if (provider === 'phonevalidator') {
    return verifyPhonePhoneValidator(phone, apiKey);
  }
  return verifyPhoneVeriphone(phone, apiKey);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start verification job
app.post('/api/verify', async (req, res) => {
  const { uploadId, phoneColumns, countryCode } = req.body;

  const activeKey = getActiveApiKey(config.apiProvider);
  if (!activeKey) {
    return res.status(400).json({ error: `API key not configured for '${config.apiProvider}'. Go to Settings to add your API key.` });
  }

  // Load upload info from memory store or disk
  let uploadInfo = uploadStore.get(uploadId);
  if (!uploadInfo) {
    const infoPath = path.join(UPLOAD_DIR, `${uploadId}-info.json`);
    if (fs.existsSync(infoPath)) {
      uploadInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    }
  }

  if (!uploadInfo) {
    return res.status(404).json({ error: 'Upload not found or session expired. Please re-upload your file.' });
  }

  const jobId = `job-${Date.now()}`;

  // Send immediate response
  res.json({ success: true, jobId, message: 'Verification started!' });

  // Process in background
  processVerification(jobId, uploadInfo, phoneColumns, countryCode).catch(err => {
    console.error('Verification error:', err);
    sendProgress(jobId, { type: 'error', message: err.message });
  });
});

async function processVerification(jobId, uploadInfo, phoneColumns, countryCode) {
  let data = uploadInfo.data;
  if (!data) {
    const workbook = XLSX.readFile(uploadInfo.filePath, { type: 'file', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    data = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }
  
  const totalRows = data.length;
  let processedCount = 0;
  let successCount = 0;
  let failCount = 0;
  let errorCount = 0;

  const stats = {
    mobile: 0,
    landline: 0,
    voip: 0,
    fixed_voip: 0,
    invalid: 0,
    unknown: 0,
    error: 0
  };

  sendProgress(jobId, {
    type: 'start',
    totalRows,
    message: `Starting verification of ${totalRows} records...`
  });

  // Process in batches to respect rate limits
  const BATCH_SIZE = 10;
  const BATCH_DELAY = 1000; // 1 second between batches

  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);
    
    const promises = batch.map(async (row, idx) => {
      const globalIdx = i + idx;
      
      // Process each selected phone column
      for (const phoneCol of phoneColumns) {
        let phoneValue = row[phoneCol];
        if (!phoneValue) {
          // Set empty results for missing phones
          row[`${phoneCol}_valid`] = false;
          row[`${phoneCol}_line_type`] = 'missing';
          row[`${phoneCol}_carrier`] = '';
          row[`${phoneCol}_country`] = '';
          row[`${phoneCol}_international`] = '';
          row[`${phoneCol}_status`] = 'missing_number';
          stats.invalid++;
          continue;
        }

        // Format phone number with robust fallback
        const fullPhone = formatPhoneNumber(phoneValue, countryCode);

        // Get current best key (auto-rotates when one runs out)
        const activeKey = getActiveApiKey(config.apiProvider);
        const result = await verifyPhone(fullPhone, activeKey, config.apiProvider);
        
        // Add results as new columns
        row[`${phoneCol}_valid`] = result.phone_valid;
        row[`${phoneCol}_line_type`] = result.phone_line_type;
        row[`${phoneCol}_carrier`] = result.phone_carrier;
        row[`${phoneCol}_country`] = result.phone_country;
        row[`${phoneCol}_international`] = result.phone_international_format;
        row[`${phoneCol}_status`] = result.verification_status;

        // Update stats
        const lineType = (result.phone_line_type || '').toLowerCase();
        if (lineType.includes('mobile')) stats.mobile++;
        else if (lineType.includes('landline') || lineType.includes('fixed_line')) stats.landline++;
        else if (lineType.includes('voip')) stats.voip++;
        else if (result.verification_status === 'invalid' || result.verification_status === 'invalid_format') stats.invalid++;
        else if (result.verification_status.startsWith('error')) stats.error++;
        else stats.unknown++;

        if (result.phone_valid) successCount++;
        else if (result.verification_status.startsWith('error')) errorCount++;
        else failCount++;
      }

      processedCount++;
    });

    await Promise.all(promises);

    // Send progress update
    const percent = Math.round((processedCount / totalRows) * 100);
    sendProgress(jobId, {
      type: 'progress',
      processed: processedCount,
      totalRows,
      percent,
      successCount,
      failCount,
      errorCount,
      stats,
      message: `Processed ${processedCount} of ${totalRows} (${percent}%)`
    });

    // Rate limit delay between batches
    if (i + BATCH_SIZE < data.length) {
      await sleep(BATCH_DELAY);
    }
  }

  // Generate output files — full + filtered by line type
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = path.basename(uploadInfo.originalName, path.extname(uploadInfo.originalName));

  // Helper to detect line type from any phone column result
  function getRowLineType(row) {
    for (const phoneCol of phoneColumns) {
      const lt = (row[`${phoneCol}_line_type`] || '').toLowerCase();
      if (lt) return lt;
    }
    return 'unknown';
  }

  function isRowValid(row) {
    for (const phoneCol of phoneColumns) {
      if (row[`${phoneCol}_valid`] === true || row[`${phoneCol}_valid`] === 'true') return true;
    }
    return false;
  }

  // Define all filter sets
  const filterSets = [
    { suffix: 'ALL', label: 'All Data', filter: () => true },
    { suffix: 'MOBILE', label: 'Mobile Only', filter: (row) => getRowLineType(row).includes('mobile') },
    { suffix: 'LANDLINE', label: 'Landline Only', filter: (row) => { const lt = getRowLineType(row); return lt.includes('landline') || lt.includes('fixed_line'); } },
    { suffix: 'VOIP', label: 'VoIP Only', filter: (row) => getRowLineType(row).includes('voip') },
    { suffix: 'VALID', label: 'All Valid Numbers', filter: (row) => isRowValid(row) },
    { suffix: 'INVALID', label: 'Invalid Numbers', filter: (row) => !isRowValid(row) }
  ];

  const outputFiles = {};

  for (const filterSet of filterSets) {
    const filteredData = data.filter(filterSet.filter);
    if (filteredData.length === 0) {
      outputFiles[filterSet.suffix] = { fileName: null, count: 0, label: filterSet.label };
      continue;
    }

    const fileName = `verified_${baseName}_${filterSet.suffix}_${timestamp}.csv`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    let autoPath = '';

    // Generate CSV buffer in memory (works on both local and Vercel)
    const sheet = XLSX.utils.json_to_sheet(filteredData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, filterSet.label);
    const csvBuffer = Buffer.from(XLSX.write(wb, { bookType: 'csv', type: 'buffer' }));

    // Store in memory for Vercel downloads
    downloadStore.set(fileName, { buffer: csvBuffer, mimeType: 'text/csv' });

    // Also try to write to disk (works locally, fails silently on Vercel)
    try {
      fs.writeFileSync(filePath, csvBuffer);
      autoPath = path.join(__dirname, fileName);
      fs.copyFileSync(filePath, autoPath);
    } catch (e) {
      // Read-only filesystem on Vercel — downloads will be served from memory
    }

    outputFiles[filterSet.suffix] = { fileName, count: filteredData.length, label: filterSet.label, autoSavePath: autoPath };
  }

  // Save batch job metadata for organized History view
  const jobMeta = {
    jobId,
    apiProvider: config.apiProvider,
    originalName: uploadInfo.originalName,
    timestamp: new Date().toISOString(),
    totalRows,
    processedCount,
    successCount,
    failCount,
    errorCount,
    stats,
    outputFiles,
    autoSavePath: outputFiles.ALL?.autoSavePath || ''
  };

  const JOBS_FILE = path.join(__dirname, 'jobs_history.json');
  let jobsHistory = [];
  try {
    if (fs.existsSync(JOBS_FILE)) {
      jobsHistory = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    }
    jobsHistory.unshift(jobMeta);
    fs.writeFileSync(JOBS_FILE, JSON.stringify(jobsHistory, null, 2));
  } catch (e) {}

  // Save config (updated credits after batch)
  saveConfig();

  sendProgress(jobId, {
    type: 'complete',
    apiProvider: config.apiProvider,
    processed: processedCount,
    totalRows,
    percent: 100,
    successCount,
    failCount,
    errorCount,
    stats,
    outputFiles,
    outputFileName: outputFiles.ALL?.fileName || '',
    autoSavePath: outputFiles.ALL?.autoSavePath || '',
    message: `✅ Verification complete! ${processedCount} records processed via ${config.apiProvider}.`
  });
}

// Download output file — serves from memory first, then disk as fallback
app.get('/api/download/:filename', (req, res) => {
  const { filename } = req.params;
  
  // Try memory store first (works on Vercel)
  const memFile = downloadStore.get(filename);
  if (memFile) {
    res.setHeader('Content-Type', memFile.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(memFile.buffer);
  }

  // Fallback to disk (works locally)
  const filePath = path.join(OUTPUT_DIR, filename);
  if (fs.existsSync(filePath)) {
    return res.download(filePath, filename);
  }

  res.status(404).json({ error: 'File not found. The file may have expired from the session. Please re-run verification.' });
});

// Get batch job history
app.get('/api/history', (req, res) => {
  const JOBS_FILE = path.join(__dirname, 'jobs_history.json');
  if (!fs.existsSync(JOBS_FILE)) return res.json({ jobs: [] });
  try {
    const jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    res.json({ jobs });
  } catch (error) {
    res.json({ jobs: [] });
  }
});

// List output files
app.get('/api/outputs', (req, res) => {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) return res.json({ files: [] });
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.endsWith('.csv'))
      .map(f => {
        const stat = fs.statSync(path.join(OUTPUT_DIR, f));
        return {
          name: f,
          size: stat.size,
          created: stat.birthtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    
    res.json({ files });
  } catch (error) {
    res.json({ files: [] });
  }
});

// Catch-all route to serve index.html for frontend
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Export app for Vercel serverless functions
module.exports = app;

if (require.main === module && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🚀 Phone Verification Tool running at http://localhost:${PORT}`);
    console.log(`📂 Output folder: ${OUTPUT_DIR}`);
    console.log(`⚙️  Configure API key at http://localhost:${PORT} → Settings\n`);
  });
}
