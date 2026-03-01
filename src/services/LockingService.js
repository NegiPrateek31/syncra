"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LockingService = void 0;
const pg_1 = require("pg");
const socket_io_1 = require("socket.io");
class LockingService {
    db;
    io;
    LOCK_TIMEOUT_MINUTES = 10;
    constructor(db, io) {
        this.db = db;
        this.io = io;
    }
    /**
     * [STEP 1: RESERVE]
     * Salesman soft-locks the item. Returns true if successfully claimed (First-to-Cloud).
     * Uses PostgreSQL 'FOR UPDATE SKIP LOCKED' to prevent thread blocking and instantly reject double-locks.
     */
    async reserveItem(itemId, salesmanId) {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(`
                SELECT id, status, locked_at 
                FROM items 
                WHERE id = $1 
                FOR UPDATE SKIP LOCKED
            `, [itemId]);
            // If no rows returned, another transaction is actively mutating this EXACT item right now.
            if (rows.length === 0) {
                await client.query('ROLLBACK');
                return false;
            }
            const item = rows[0];
            const now = new Date();
            const isExpired = item.locked_at &&
                (now.getTime() - new Date(item.locked_at).getTime() > this.LOCK_TIMEOUT_MINUTES * 60 * 1000);
            if (item.status === 'sold' || (item.status === 'locked' && !isExpired)) {
                await client.query('ROLLBACK');
                return false; // Item unavailable
            }
            // Grant lock: "first-to-cloud" winner
            await client.query(`
                UPDATE items 
                SET status = 'locked', 
                    locked_by = $1, 
                    locked_at = NOW(),
                    version = version + 1
                WHERE id = $2
            `, [salesmanId, itemId]);
            await client.query('COMMIT');
            // Globally Broadcast the Soft-Lock (Clients process this globally, UI is optimistic locally)
            this.io.emit('item_yellow', { itemId, salesmanId });
            return true;
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    /**
     * [STEP 2: TOKENIZE]
     * Salesman generates Bill ID. Once this executes, they lose edit access.
     */
    async tokenizeBill(itemIds, salesmanId) {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            // Generate deterministic short-bill ID (e.g. #5521)
            const tokenId = '#' + Math.floor(1000 + Math.random() * 9000).toString();
            const billRes = await client.query(`
                INSERT INTO bills (token_id, salesman_id, status)
                VALUES ($1, $2, 'pending')
                RETURNING id
            `, [tokenId, salesmanId]);
            const billId = billRes.rows[0].id;
            // Associate items ONLY if they are currently locked by THIS salesman
            const updateRes = await client.query(`
                UPDATE items
                SET bill_id = $1
                WHERE id = ANY($2) AND locked_by = $3 AND status = 'locked'
            `, [billId, itemIds, salesmanId]);
            // Prevent generation if some items expired or belonged to another user
            if (updateRes.rowCount !== itemIds.length) {
                throw new Error("Validation Failed: Some items are no longer locked by you.");
            }
            await client.query('COMMIT');
            // Broadcast that these items are no longer editable by the floor
            this.io.emit('bill_created', { billId, tokenId, itemIds });
            return tokenId;
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
    /**
     * [STEP 3: VERIFY]
     * Owner 'Master Edit Power'. Owner finalizes bill and hard-deducts.
     * Optionally adjusts final items on the bill.
     */
    async finalizeBill(billId, ownerId, finalItemIds) {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query('SELECT role FROM users WHERE id = $1', [ownerId]);
            if (userRes.rows[0]?.role !== 'owner') {
                throw new Error("Unauthorized: Owner restricted action.");
            }
            // 1. Master Edit: Anything previously associated with this bill but REMOVED by owner goes back to green
            await client.query(`
                UPDATE items
                SET status = 'available', locked_by = NULL, locked_at = NULL, bill_id = NULL
                WHERE bill_id = $1 AND id != ALL($2)
            `, [billId, finalItemIds]);
            // 2. Finalize remaining specific items to 'Red/Sold'
            await client.query(`
                UPDATE items
                SET status = 'sold', locked_by = $1, bill_id = $2
                WHERE id = ANY($3)
            `, [ownerId, billId, finalItemIds]);
            // 3. Mark the bill as closed
            await client.query(`
                UPDATE bills SET status = 'finalized' WHERE id = $1
            `, [billId]);
            await client.query('COMMIT');
            // Real-Time Emit: Items turn red globally
            this.io.emit('items_red_sold', { billId, itemIds: finalItemIds });
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
        }
    }
}
exports.LockingService = LockingService;
//# sourceMappingURL=LockingService.js.map