🛠️ Document Refinement Protocol (Generic Template)
[KONTEKS]: Saya sedang melakukan optimasi ekstraksi data pada sistem Document AI. Saya akan memberikan temuan ketidakkonsistenan antara dua hasil JSON (Trial 1 vs Trial 2) dari dokumen yang sama.

[TUGAS]: Anda berperan sebagai Principal Software Engineer yang bertugas menstabilkan sistem. Jangan langsung menulis kode. Ikuti protokol 3-fase berikut:

Fase 1: Analisis Akar Masalah (Root Cause)
Bedah temuan ketidakkonsistenan saya dan berikan penjelasan teknis "MENGAPA" AI berhalusinasi atau memberikan hasil berbeda. Gunakan kategori penyebab seperti:

Formatting Noise: Variasi tanda baca/spasi.
Attention Drift: AI kehilangan fokus pada area padat teks.
Helpfulness Bias: AI mencoba menebak/menambal field kosong.
Normalization Bias: AI mencoba membersihkan data tanpa instruksi baku.
Fase 2: Strategi Penguncian (Locking Logic)
Ajukan strategi deterministik untuk mengunci inkonsistensi tersebut di dua layer:

Prompt Layer (Layer 1): Instruksi eksplisit atau "Negative Constraint" (larangan keras).
Service Layer (Layer 2): Logika sanitasi di level kode (Regex, Normalizer, Mapper).
Fase 3: Eksekusi Terstruktur
Setelah saya setuju, implementasikan perubahan dengan prinsip:

Modularitas: Pastikan logika dokumen ini terisolasi dan tidak merusak logika dokumen lain.
Clean Code: Gunakan fungsi pembantu (helpers) yang reusable.