# OCR Document Processing Backend

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-5.x-000000?style=for-the-badge&logo=express&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14+-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-6+-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![BullMQ](https://img.shields.io/badge/BullMQ-Queue-FF6B35?style=for-the-badge&logo=bull&logoColor=white)
![Google Gemini](https://img.shields.io/badge/Google_Gemini-AI-4285F4?style=for-the-badge&logo=google&logoColor=white)

A production-grade, asynchronous document intelligence backend for processing complex logistics, customs, and licensing documents. Built to handle the full diversity of Indonesian import/export paperwork — from Commercial Invoices to BPOM permits — with high accuracy using a multi-strategy AI extraction engine on top of Google Gemini.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#-key-features)
- [System Architecture](#-system-architecture)
- [Tech Stack](#️-tech-stack)
- [Getting Started](#-getting-started)
- [Supported Documents](#-supported-documents)
- [Available Scripts](#-available-scripts)

---

## Overview

extracting structured, validated data from dozens of heterogeneous document formats that each have their own layouts, fields, and edge cases — at scale, without blocking the API, and with automatic recovery from AI model failures.

The system is designed around three principles:

1. **Correctness over speed** — every extraction result is validated against a strict JSON schema with mathematical cross-checks before it is accepted.
2. **Resilience by default** — the AI response pipeline includes a self-healing layer that automatically repairs and salvages malformed or truncated outputs.
3. **Horizontal scalability** — the API server and background worker are fully decoupled services, connected only through Redis queues. Each can be scaled independently.

---

## 🚀 Key Features

### Extraction Engine

- **Adaptive Routing** — Automatically selects the optimal extraction strategy per document: _Light Mode_ for simple permit documents, _Context-Aware Sequential_ for multi-page logistics docs, and _Master-Slave Parallel_ for high-complexity batches.
- **Dual-Track Parallel Engine** — A dedicated "14-Column Flat Array" extraction track with a Row-Level Stitcher, purpose-built to handle severely reformatted Excel-to-PDF conversions (e.g., Doc `217`).
- **Self-Healing Pipeline** — A LIFO Stack AST Parser and background "Harvester" process automatically detect, repair, and recover truncated JSON responses from the AI model, eliminating silent extraction failures.

### Infrastructure

- **Non-Blocking Architecture** — All heavy extractions run through BullMQ job queues. The API server returns immediately; clients track progress via WebSocket.
- **Real-Time Progress Tracking** — Socket.io with Redis Adapter broadcasts live job status across all server instances.
- **Schema Enforcement** — Post-extraction validator applies mathematical checks (quantity × unit price = total, etc.) and forward-fill algorithms before the result is committed to the database.

---

## 🏗️ System Architecture

### Project Structure

```
src/
├── config/                   # Database, Redis, Gemini, and Logger initialization
├── controllers/              # Route handlers, input validation, HTTP response shaping
├── services/
│   └── integrations/
│       └── ai/               # Core extraction engine: strategies, handlers, helpers
├── prompts/                  # Per-document-code prompting rules and heuristics
├── schemas/                  # Absolute JSON schemas used for final output validation
├── worker/                   # BullMQ job consumers and job lifecycle management
└── utils/                    # Shared: AI Sanitizer, Business Rules, Schema Enforcer
```

---

## 🛠️ Tech Stack

### Core Runtime & Framework

| Package                                                      | Purpose                                         |
| ------------------------------------------------------------ | ----------------------------------------------- |
| [Node.js 18+](https://nodejs.org/) (ES Modules)              | Runtime — native ESM, no transpilation required |
| [Express.js v5](https://expressjs.com/)                      | HTTP framework                                  |
| [@google/genai](https://www.npmjs.com/package/@google/genai) | Google Gemini AI client                         |

### Database & Queue

| Package                                                | Purpose                              |
| ------------------------------------------------------ | ------------------------------------ |
| [PostgreSQL 14+](https://www.postgresql.org/) via `pg` | Primary relational store             |
| `node-pg-migrate`                                      | Version-controlled schema migrations |
| [BullMQ](https://docs.bullmq.io/)                      | Reliable background job queue        |
| [Redis 6+](https://redis.io/) via `ioredis`            | Queue backend, caching, and Pub/Sub  |

### Document Processing & Real-time

| Package                                                      | Purpose                                 |
| ------------------------------------------------------------ | --------------------------------------- |
| `pdf-lib`                                                    | PDF page splitting and manipulation     |
| `xlsx`                                                       | Excel file parsing                      |
| [Socket.io](https://socket.io/) + `@socket.io/redis-adapter` | Real-time job progress across instances |

### Security & Observability

| Package                | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| `jsonwebtoken`         | Stateless API authentication             |
| `bcrypt`               | Password hashing                         |
| `nanoid`               | Collision-resistant unique ID generation |
| `cors`                 | Cross-origin request policy              |
| `pino` + `pino-pretty` | High-performance structured JSON logging |

---

## 📦 Getting Started

### Prerequisites

| Requirement     | Version           |
| --------------- | ----------------- |
| Node.js         | `18.x` or later   |
| PostgreSQL      | `14+`             |
| Redis           | `6+`              |
| Package manager | npm / pnpm / yarn |

### Installation

**1. Clone the repository**

```bash
git clone https://github.com/your-repo/uniaircargo-ocr.git
cd uniaircargo-ocr
```

**2. Install dependencies**

```bash
npm install
```

**3. Configure environment variables**

```bash
cp .env.example .env
```

Open `.env` and fill in all required values:

```env
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgres://user:password@localhost:5432/uniaircargo

# Redis / BullMQ
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# Google Gemini AI
GEMINI_API_KEY=your_gemini_api_key_here

# Security
JWT_SECRET=your_super_secret_jwt_key
```

**4. Run database migrations and seed data**

This creates all tables and seeds the initial Admin account and Document Type registry:

```bash
npm run setup:db
```

> ⚠️ To wipe the database and start fresh, run `npm run reset:db`.

### Running the Services

The API server and background worker are **independent processes**. Run each in its own terminal:

```bash
# Terminal 1 — HTTP API + WebSocket server
npm run start:dev

# Terminal 2 — Background extraction worker (BullMQ consumer)
npm run worker:dev

# Terminal 3 — Webhook service (optional, for outbound event delivery)
npm run webhook
```

> In production, each service should be managed as a separate systemd unit or container replica.

---

## 📜 Supported Documents

| Code  | Document                                    | Category     |
| :---: | ------------------------------------------- | ------------ |
| `000` | Cukai                                       | Bea Cukai    |
| `001` | CIPL (Combined Invoice & Packing List)      | Logistik     |
| `217` | Packing List (Native PDF & Excel Converted) | Logistik     |
| `380` | Commercial Invoice                          | Logistik     |
| `457` | SKB (Surat Keterangan Bebas)                | Perizinan ⚡ |
| `704` | Master Bill of Lading (MBL)                 | Logistik     |
| `705` | Bill of Lading (B/L)                        | Logistik     |
| `740` | Air Waybill (AWB)                           | Logistik     |
| `741` | Master Air Waybill (MAWB)                   | Logistik     |
| `800` | POSTEL                                      | Perizinan ⚡ |
| `813` | CK (Cukai Khusus)                           | Bea Cukai    |
| `846` | SKEM / Surat Keterangan                     | Perizinan ⚡ |
| `854` | BPOM                                        | Perizinan ⚡ |
| `860` | E-COO (Electronic Certificate of Origin)    | Sertifikasi  |
| `861` | COO (Manual Certificate of Origin)          | Sertifikasi  |
| `871` | AKL                                         | Perizinan ⚡ |
| `888` | Pengecualian                                | Lainnya ⚡   |
| `957` | SNI (Standar Nasional Indonesia)            | Sertifikasi  |
| `958` | L/S (Laporan Surveyor)                      | Logistik     |
| `959` | PI (Persetujuan Impor)                      | Perizinan ⚡ |
| `999` | Lainnya (Others)                            | Lainnya      |

---

## 💻 Available Scripts

| Script                 | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `npm run start:dev`    | Start API server in development mode (nodemon)      |
| `npm run start:prod`   | Start API server in production mode                 |
| `npm run worker:dev`   | Start background worker in development mode         |
| `npm run start:worker` | Start background worker in production mode          |
| `npm run webhook`      | Start the webhook service                           |
| `npm run migrate:up`   | Run pending database migrations only                |
| `npm run setup:db`     | Run migrations + seed database (first-time setup)   |
| `npm run reset:db`     | Drop all tables — **destructive**, use with caution |
| `npm run lint`         | Run ESLint for code quality analysis                |

---

## 📄 License

This project is proprietary. All rights reserved.
