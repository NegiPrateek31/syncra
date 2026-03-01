import { Pool } from 'pg';
import { Server } from 'socket.io';

export class LockingService {
    constructor(private db: Pool, private io: Server) { }

    /**
     * Attempts to soft-lock a product variant for a salesman.
     * Broadcasting specific to the business room.
     */
    async reserveVariant(businessId: string, productId: string, variantId: string, salesmanId: string): Promise<boolean> {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');

            const { rows } = await client.query(`
                SELECT id, status, stock, version 
                FROM product_variants 
                WHERE id = $1 AND business_id = $2
                FOR UPDATE SKIP LOCKED
            `, [variantId, businessId]); // business_id added logic for safety, assuming variant ID is unique anyway

            if (rows.length === 0) {
                await client.query('ROLLBACK');
                return false; // Not found or already hard-locked by another transaction
            }

            const variant = rows[0];

            if (variant.status !== 'available' || variant.stock <= 0) {
                await client.query('ROLLBACK');
                return false; // Already locked or sold
            }

            // Lock it!
            await client.query(`
                UPDATE product_variants 
                SET status = 'locked', 
                    locked_by = $1, 
                    locked_at = NOW(), 
                    version = version + 1
                WHERE id = $2
            `, [salesmanId, variantId]);

            await client.query('COMMIT');

            // Globally Broadcast the Soft-Lock specifically to this business's room
            this.io.to(`business_${businessId}`).emit('variant_locked', {
                productId,
                variantId,
                lockedBy: salesmanId
            });

            return true;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Locking Error:', error);
            return false;
        } finally {
            client.release();
        }
    }

    /**
     * Releases a soft-lock (manual release or timeout).
     */
    async unlockVariant(businessId: string, productId: string, variantId: string): Promise<void> {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');

            await client.query(`
                UPDATE product_variants 
                SET status = 'available', 
                    locked_by = NULL, 
                    locked_at = NULL, 
                    bill_id = NULL,
                    version = version + 1
                WHERE id = $1 AND status = 'locked'
            `, [variantId]);

            await client.query('COMMIT');

            this.io.to(`business_${businessId}`).emit('variant_unlocked', {
                productId,
                variantId
            });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Unlocking Error:', error);
        } finally {
            client.release();
        }
    }

    /**
     * Generates a pending Bill Token, freezing the item for Owner finalization.
     */
    async tokenizeVariant(businessId: string, productId: string, variantId: string, salesmanId: string): Promise<string> {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');

            // Verify the salesman owns the lock
            const { rows } = await client.query(`
                SELECT id FROM product_variants 
                WHERE id = $1 AND locked_by = $2 AND status = 'locked'
            `, [variantId, salesmanId]);

            if (rows.length === 0) {
                await client.query('ROLLBACK');
                throw new Error("Cannot generate bill: Variant not locked by this salesman.");
            }

            // Create Bill Token
            const tokenStr = `#${(1000 + Math.floor(Math.random() * 9000))}`; // Simple 4 digit hash
            const billRes = await client.query(`
                INSERT INTO bills (business_id, token_id, salesman_id, status)
                VALUES ($1, $2, $3, 'pending')
                RETURNING id, token_id
            `, [businessId, tokenStr, salesmanId]);

            const billId = billRes.rows[0].id;
            const generatedToken = billRes.rows[0].token_id;

            // Associate Variant with Bill
            await client.query(`
                UPDATE product_variants
                SET bill_id = $1, version = version + 1
                WHERE id = $2
            `, [billId, variantId]);

            await client.query('COMMIT');

            // Note: We don't change 'status' away from locked until the Owner finalizing it.
            // But we can emit an event that a bill exists.
            this.io.to(`business_${businessId}`).emit('variant_billed', {
                productId,
                variantId,
                billId: generatedToken
            });

            return generatedToken;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Owner finalizes the bill, officially hard-deducting stock.
     */
    async finalizeBill(businessId: string, billId: string): Promise<void> {
        const client = await this.db.connect();
        try {
            await client.query('BEGIN');

            await client.query(`
                UPDATE bills SET status = 'finalized', updated_at = NOW() 
                WHERE id = $1 AND business_id = $2
            `, [billId, businessId]);

            // Deduct stock and change status to 'sold'
            // If stock becomes 0, status is sold. If stock > 0, technically it becomes available again minus 1.
            // For simplicity here, assuming a variant represents the exact stock (or adjusting stock - 1).
            const { rows: variants } = await client.query(`
                UPDATE product_variants
                SET stock = stock - 1,
                    status = CASE WHEN stock - 1 <= 0 THEN 'sold'::product_status ELSE 'available'::product_status END,
                    locked_by = NULL,
                    locked_at = NULL,
                    bill_id = NULL,
                    version = version + 1
                WHERE bill_id = $1
                RETURNING id, product_id, stock, status
            `, [billId]);

            await client.query('COMMIT');

            for (const v of variants) {
                this.io.to(`business_${businessId}`).emit('variant_stock_updated', {
                    productId: v.product_id,
                    variantId: v.id,
                    stock: v.stock,
                    status: v.status
                });
            }

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Finalize Bill Error:', error);
            throw error;
        } finally {
            client.release();
        }
    }
}
