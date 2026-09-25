# 📱 PhoneFilter Pro — Bulk Phone Verification Tool

A fast, modern web application for bulk phone number verification, line-type classification (**Mobile**, **Landline**, **VoIP**), and carrier detection. Designed for SMS marketing campaigns, cold outreach, and lead list cleaning.

![PhoneFilter Pro](https://img.shields.io/badge/Status-Production%20Ready-brightgreen)
![License](https://img.shields.io/badge/License-MIT-blue)
![Vercel Ready](https://img.shields.io/badge/Vercel-Deployable-black)

---

## ✨ Key Features

- 📤 **Universal CSV & Excel Support**: Drag & drop any `.csv`, `.xlsx`, or `.xls` file. Auto-detects phone number columns and preserves all original data columns.
- 📱 **Carrier & Line-Type Detection**:
  - **Mobile**: Filter leads ready for SMS text marketing.
  - **Landline**: Separate numbers that only support voice calls.
  - **VoIP**: Detect virtual numbers (Google Voice, RingCentral, Twilio, TextNow).
  - **Invalid & Fake**: Remove dead or non-existent numbers.
- 🌐 **Multi-Provider API Support**:
  - **Veriphone**: Fast, low-cost verification ($0.0002/lookup).
  - **PhoneValidator.com**: Full V4 API integration with ported carrier detection ($0.004/lookup).
- 📥 **Targeted Export Downloads**: Export filtered CSV files instantly with one click:
  - `Mobile Only`
  - `Landline Only`
  - `VoIP Only`
  - `All Valid`
  - `Invalid Numbers`
  - `All Verified Data`
- 📁 **Organized Batch History**: Grouped verification history with stats breakdown and download actions.
- ⚡ **Vercel Serverless Ready**: Built with memory storage and serverless Express architecture for zero-config Vercel deployment.

---

## 🚀 Quick Start (Local Development)

1. **Clone the repository**:
   ```bash
   git clone https://github.com/arwebcrafts/phone-filter-pro.git
   cd phone-filter-pro
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the server**:
   ```bash
   npm run dev
   ```
   Open your browser at [http://localhost:3847](http://localhost:3847).

4. **Configure API Key**:
   - Go to **Settings** tab in the web UI.
   - Enter your API Key from **Veriphone.io** or **PhoneValidator.com**.

---

## ☁️ Deploying to Vercel

This repository includes a `vercel.json` configuration and is 100% Vercel-ready.

1. Install Vercel CLI (optional) or connect your GitHub repository directly at [Vercel.com](https://vercel.com).
2. Push your code to GitHub.
3. Import the repository on Vercel — Vercel will automatically detect the Node.js Express server.
4. Set optional Environment Variables in Vercel settings:
   - `API_KEY`: Your default API key.
   - `API_PROVIDER`: `veriphone` or `phonevalidator`.

---

## 🛠️ Built With

- **Backend**: Node.js, Express, Multer, SheetJS (XLSX), CORS
- **Frontend**: Vanilla HTML5, Modern CSS Design System, ES6 JavaScript
- **Deployment**: Vercel Serverless `@vercel/node`

---

## 📄 License

MIT License. Free for personal and commercial use.
