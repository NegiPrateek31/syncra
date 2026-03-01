# Syncra: Core Backend & DB Implementation

This project implements the foundational database schema and concurrency services for **Syncra**, a commercial-grade, local-first inventory system with high-performance real-time syncing.

## Architecture Highlights
- **First-to-Cloud Resolution:** Overcomes sync conflicts using PostgreSQL `FOR UPDATE SKIP LOCKED`. If two users offline-sync the same soft-lock, the database securely serves as the Final Arbiter.
- **Role-Based Workflows:** Distinct constraints for *Owner* (Admin rules, hard-deductions) and *Salesman* (Soft-locks, tokens).
- **Millisecond Broadcasts:** Socket.io emits state globally to provide sub-second "lock updates" to the frontend.

## Deliverables
1. **`schema.sql`**: The Supabase/PostgreSQL schema encompassing Users, Items, and Bills with status ENUMs, relations, and update triggers.
2. **`src/services/LockingService.ts`**: The TypeScript logic that implements:
   - `reserveItem` (Soft-Lock to Yellow State)
   - `tokenizeBill` (Generate Bill ID #5521 and remove Salesman edit-access)
   - `finalizeBill` (Owner confirmation, Master Edit Power, to Red state)

## Getting Started

1. **Database Setup**
   Run the `schema.sql` script in your local PostgreSQL instance or execute it in your Supabase SQL Editor.
   
2. **Service Setup**
   The project is pre-configured with TypeScript.
   ```bash
   npm install
   npx tsc
   ```

*Deliverables have been constructed exactly to project specifications for Syncra.*