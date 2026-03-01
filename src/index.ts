import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { LockingService } from './services/LockingService';
import { AuthService } from './services/AuthService';
import { InventoryService } from './services/InventoryService';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: '*', // For development. Update in production.
    }
});

// Assuming a real PostgreSQL connection string is in .env or passed via environment
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/syncra',
});

const lockingService = new LockingService(pool, io);
const authService = new AuthService(pool);
const inventoryService = new InventoryService(pool);

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Syncra Real-Time Engine Running' });
});

// --- Auth Routes ---
app.post('/api/auth/owner/register', async (req, res) => {
    try {
        const result = await authService.registerOwner(req.body);
        res.json(result);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/auth/salesman/request-otp', async (req, res) => {
    try {
        const { contact } = req.body;
        const result = await authService.requestSalesmanOtp(contact);
        res.json(result);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/auth/salesman/verify-otp', async (req, res) => {
    try {
        const { contact, otp } = req.body;
        const result = await authService.verifySalesmanOtp(contact, otp);
        res.json(result);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

// --- Staff Auth / Users ---
app.get('/api/staff/:businessId', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT id, name, email, phone, role as status, created_at as "joinedAt"
            FROM users WHERE business_id = $1 AND role = 'salesman'
        `, [req.params.businessId]);
        res.json(rows);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/staff/invite', async (req, res) => {
    try {
        const { businessId, email, phone } = req.body;
        await pool.query(`
            INSERT INTO invites (business_id, contact)
            VALUES ($1, $2)
        `, [businessId, email || phone]);

        // Simulate sending a verification email
        console.log(`\n========================================`);
        console.log(`📧 ENVELOPE: Sending Verification Email to: ${email || phone}`);
        console.log(`SUBJECT: You're invited to join Syncra Pro!`);
        console.log(`BODY: Please download the Syncra Pro app and login using your phone/email to get started.`);
        console.log(`========================================\n`);

        res.json({ message: 'Invite sent successfully' });
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

// --- Inventory / Products ---
app.get('/api/inventory/:businessId', async (req, res) => {
    try {
        const result = await inventoryService.getInventory(req.params.businessId);
        res.json(result);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/inventory/:businessId/product/:productId', async (req, res) => {
    try {
        const result = await inventoryService.getProductById(req.params.businessId, req.params.productId);
        if (!result) return res.status(404).json({ error: "Product not found" });
        res.json(result);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/api/inventory/:businessId/product', async (req, res) => {
    try {
        const result = await inventoryService.addProduct(req.params.businessId, req.body);
        res.json(result);
    } catch (e: any) {
        res.status(400).json({ error: e.message });
    }
});

// --- Socket.io Real-Time Connections ---
io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Join a specific business room to isolate broadcasts
    socket.on('join_business', (businessId: string) => {
        socket.join(`business_${businessId}`);
        console.log(`[Socket] ${socket.id} joined business_${businessId}`);
    });

    socket.on('reserve_request', async (data) => {
        const { businessId, productId, variantId, salesmanId } = data;
        try {
            const success = await lockingService.reserveVariant(businessId, productId, variantId, salesmanId);
            if (!success) {
                // If the item was already locked, explicitly tell THIS client it failed so UI reverts
                socket.emit('reserve_failed', { variantId });
            }
        } catch (error) {
            console.error('[Socket Error] reserve_request:', error);
            socket.emit('reserve_failed', { variantId });
        }
    });

    socket.on('unlock_request', async (data) => {
        const { businessId, productId, variantId } = data;
        try {
            await lockingService.unlockVariant(businessId, productId, variantId);
        } catch (error) {
            console.error('[Socket Error] unlock_request:', error);
        }
    });

    socket.on('generate_bill', async (data) => {
        const { businessId, productId, variantId, salesmanId } = data;
        try {
            const token = await lockingService.tokenizeVariant(businessId, productId, variantId, salesmanId);
            socket.emit('bill_generated', { variantId, token });
        } catch (error: any) {
            console.error('[Socket Error] generate_bill:', error);
            socket.emit('bill_error', { variantId, message: error.message });
        }
    });

    socket.on('finalize_bill', async (data) => {
        const { businessId, billId } = data;
        try {
            await lockingService.finalizeBill(businessId, billId);
        } catch (error: any) {
            console.error('[Socket Error] finalize_bill:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected: ${socket.id}`);
        // Potential cleanup here
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Syncra Engine API & Socket Server running on port ${PORT}`);
});
