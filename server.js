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
const jobResultsStore = new Map();

// In-memory config store supporting separate provider keys
let config = {
  apiProvider: process.env.API_PROVIDER || 'veriphone',
  veriphoneApiKey: process.env.VERIPHONE_API_KEY || process.env.API_KEY || '',
  phonevalidatorApiKey: process.env.PHONEVALIDATOR_API_KEY || '',
  apiKey: process.env.API_KEY || ''
};

// Load config from file if exists
const CONFIG_FILE = path.join(__dirname, 'config.json');
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...loaded };
  } catch (e) {
    console.log('Could not load config, using defaults');
  }
}

function getActiveApiKey(provider) {
  const p = provider || config.apiProvider;
  if (p === 'phonevalidator') {
    return config.phonevalidatorApiKey || config.apiKey || '';
  }
  return config.veriphoneApiKey || config.apiKey || '';
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
  const veriphoneKey = config.veriphoneApiKey || (config.apiProvider === 'veriphone' ? config.apiKey : '');
  const phonevalidatorKey = config.phonevalidatorApiKey || (config.apiProvider === 'phonevalidator' ? config.apiKey : '');
  const activeKey = getActiveApiKey(config.apiProvider);

  function maskKey(key) {
    if (!key) return '';
    return `${key.slice(0, 4)}${'*'.repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`;
  }

  res.json({
    apiProvider: config.apiProvider,
    hasApiKey: !!activeKey,
    apiKeyMasked: maskKey(activeKey),
    hasVeriphoneKey: !!veriphoneKey,
    veriphoneKeyMasked: maskKey(veriphoneKey),
    hasPhonevalidatorKey: !!phonevalidatorKey,
    phonevalidatorKeyMasked: maskKey(phonevalidatorKey)
  });
});

app.post('/api/config', (req, res) => {
  const { apiKey, apiProvider, veriphoneApiKey, phonevalidatorApiKey } = req.body;
  if (apiProvider !== undefined) config.apiProvider = apiProvider;
  
  if (veriphoneApiKey !== undefined) config.veriphoneApiKey = veriphoneApiKey;
  if (phonevalidatorApiKey !== undefined) config.phonevalidatorApiKey = phonevalidatorApiKey;

  if (apiKey !== undefined && !apiKey.includes('*')) {
    if (config.apiProvider === 'phonevalidator') {
      config.phonevalidatorApiKey = apiKey;
    } else {
      config.veriphoneApiKey = apiKey;
    }
    config.apiKey = apiKey;
  }
  
  saveConfig();
  res.json({ success: true, message: 'Configuration saved!' });
});

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
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    
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

    try {
      const sheet = XLSX.utils.json_to_sheet(filteredData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheet, filterSet.label);
      XLSX.writeFile(wb, filePath, { bookType: 'csv' });

      autoPath = path.join(__dirname, fileName);
      fs.copyFileSync(filePath, autoPath);
    } catch (e) {
      console.log('File write skipped (read-only filesystem or Vercel serverless environment)');
    }

    outputFiles[filterSet.suffix] = { fileName, count: filteredData.length, label: filterSet.label, autoSavePath: autoPath };
  }

  // Save batch job metadata for organized History view
  const jobMeta = {
    jobId,
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

  sendProgress(jobId, {
    type: 'complete',
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
    message: `✅ Verification complete! ${processedCount} records processed.`
  });
}

// Download output file
app.get('/api/download/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(OUTPUT_DIR, filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, filename);
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
