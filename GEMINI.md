# Project Overview: UniAirCargo OCR Backend

Project ini adalah sistem backend berbasis AI yang dirancang khusus untuk otomatisasi ekstraksi data dari dokumen logistik udara (Air Cargo). Sistem ini menggunakan model Google Gemini untuk melakukan klasifikasi dokumen, deteksi batas (boundary detection), dan ekstraksi data terstruktur dengan tingkat akurasi tinggi.

## 🚀 Fitur Utama

- **Boundary Detection & Splitting**: Secara otomatis mendeteksi batas-batas dokumen dalam satu file PDF multi-halaman dan memecahnya menjadi dokumen-dokumen individu.
- **AI-Powered Data Extraction**: Mengekstrak data terstruktur (JSON) dari PDF, Gambar, dan Excel menggunakan model Gemini (Flash & Flash Lite).
- **Map-Reduce Processing**: Menggunakan teknik Map-Reduce untuk menangani dokumen PDF atau Excel yang sangat panjang guna menghindari limitasi token dan pemotongan JSON (truncation).
- **Self-Healing AI Engine**: Logika retry otomatis jika output AI tidak valid atau terputus.
- **Dynamic Schema Enforcement**: Memastikan output data AI selalu sesuai dengan kontrak skema JSON yang ditentukan untuk setiap tipe dokumen.
- **Real-time Updates**: Notifikasi status pemrosesan dokumen secara real-time melalui Socket.io.
- **Webhook Integration**: Mengirimkan hasil ekstraksi ke sistem pihak ketiga setelah pemrosesan selesai.
- **EAV Storage Pattern**: Menyimpan data hasil ekstraksi menggunakan pola Entity-Attribute-Value untuk fleksibilitas atribut yang dinamis.

## 🛠️ Tech Stack

- **Runtime**: Node.js (ES Modules)
- **Web Framework**: Express.js
- **Database**: PostgreSQL
- **Migration**: node-pg-migrate
- **Task Queue**: BullMQ (Redis-based)
- **Cache & Real-time**: Redis & Socket.io
- **AI Integration**: @google/genai (Google Gemini SDK)
- **Document Processing**: pdf-lib, xlsx, multer
- **Security**: JWT, Bcrypt

## 📂 Struktur Proyek Utama

- `src/server.js`: Entry point untuk API server.
- `src/worker.js`: Entry point untuk background worker (BullMQ).
- `src/services/integrations/ai-service.js`: Inti dari integrasi AI (Gemini), mencakup logika boundary detection dan smart extraction.
- `src/queues/`: Definisi antrean untuk pemrosesan background (boundary, extraction, webhook).
- `src/prompts/`: Template prompt AI untuk instruksi yang presisi kepada Gemini.
- `src/schemas/`: Kontrak skema JSON untuk berbagai tipe dokumen logistik (001, 705, 380, dll).
- `src/services/eav/`: Repositori untuk penyimpanan data dinamis hasil ekstraksi.

## 🔄 Workflow Pemrosesan Dokumen

1. **Upload**: User mengunggah file (PDF/Excel/Image).
2. **Boundary Detection**: File masuk ke `boundary-queue`. AI mendeteksi letak awal dan akhir setiap dokumen unik.
3. **Splitting**: Jika PDF, sistem memecah file menjadi potongan-potongan dokumen kecil.
4. **Extraction**: Setiap dokumen masuk ke `extraction-queue`. AI mengekstrak data berdasarkan skema yang relevan.
5. **Storage**: Hasil ekstraksi disimpan ke PostgreSQL dan metrik (token usage, cost, duration) dicatat.
6. **Notification**: Sistem memicu webhook dan mengirim update status via Socket.io.

## 🤖 Konfigurasi AI (Gemini)

Sistem menggunakan dua tier model:
- **CHEAP (gemini-3.1-flash-lite-preview)**: Digunakan untuk tugas ringan seperti deteksi batas halaman.
- **FLAGSHIP (gemini-3-flash-preview)**: Digunakan untuk tugas ekstraksi data yang kompleks dan presisi.

---
*Dibuat oleh Antigravity AI Coding Assistant*
