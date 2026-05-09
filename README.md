# 🚀 UniAirCargo OCR (Document Extraction)

## 🌟 Tech Stack

- **Backend Framework:** Node.js (ESM), Express.js
- **AI/LLM Engine:** Google GenAI SDK (`@google/genai`)
- **Queue & Background Jobs:** BullMQ, Redis (`ioredis`)
- **Database & ORM:** PostgreSQL (`pg`), `node-pg-migrate`
- **Real-time WebSocket:** Socket.io dengan Redis Adapter
- **Document Parsers:** `pdf-lib` (PDF manipulation), `xlsx` (Excel parsing)
- **Security:** JWT, Bcrypt, NanoID
- **Logging:** Pino & Pino-Pretty

---

## 🛠️ Getting Started

### 1. Prerequisites

Pastikan servis berikut sudah berjalan di _environment_ Anda:

- **Node.js** (v18.x or newer)
- **PostgreSQL** (v14+)
- **Redis Server** (v6+)

### 2. Installation

_Clone_ repositori dan instal semua dependensi:

```bash
git clone <repository_url>
cd uniaircargo-ocr
npm install
3. Environment Variables
Buat file .env di root directory. (Gunakan .env.example sebagai referensi):

Code snippet
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgres://user:password@localhost:5432/uniaircargo

# Redis / Queue
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Google Gemini AI
GEMINI_API_KEY=your_gemini_api_key_here

# Security
JWT_SECRET=your_super_secret_key
4. Database Setup
Jalankan perintah ini untuk menjalankan migrasi table dan menyuntikkan data seed (Admin & Document Types):

Bash
npm run setup:db
(Catatan: Jika ingin mereset/menghapus seluruh tabel, jalankan npm run reset:db).

🚀 Running the Application
Sistem ini terdiri dari beberapa servis yang berjalan secara terpisah untuk skalabilitas maksimal. Buka terminal yang berbeda untuk masing-masing servis:

1. Jalankan API Server (Express + Socket.io):

Bash
npm run start:dev
2. Jalankan Background Worker (BullMQ + Gemini AI):

Bash
npm run worker:dev
3. Jalankan Webhook Service (Optional):

Bash
npm run webhook
📚 API Documentation
API Documentation interaktif menggunakan Swagger UI.
Setelah server berjalan, buka browser dan akses URL berikut:
👉 http://localhost:3000/api-docs

📜 Supported Documents
Sistem memiliki JSON Schema dan instruksi presisi untuk mengekstrak data dari dokumen logistik berikut:

001: CIPL (Combined Invoice & Packing List)

217: Packing List (Native & Excel Converted)

380: Commercial Invoice

705: Bill of Lading (B/L)

740: Air Waybill (AWB)

846: SKEM / Surat Keterangan

860: E-COO (Electronic Certificate of Origin)

861: COO (Manual Certificate of Origin)

958: L/S (Laporan Surveyor)
```
