import { Pool } from 'pg';

export class InventoryService {
    private pool: Pool;

    constructor(pool: Pool) {
        this.pool = pool;
    }

    /**
     * Fetch all products for a business, including their variants and a single thumbnail image.
     */
    async getInventory(businessId: string) {
        // We use JSON aggregation to return variants and the thumbnail inline
        const query = `
            SELECT 
                p.id, p.name, p.brand, p.sku, p.category, p.description, p.price, p.color_index,
                (SELECT image_url FROM product_images WHERE product_id = p.id AND is_thumbnail = true LIMIT 1) as "imageUrl",
                COALESCE(
                    (
                        SELECT json_agg(json_build_object(
                            'id', v.id,
                            'size', v.size,
                            'stock', v.stock,
                            'status', v.status,
                            'lockedBy', v.locked_by,
                            'billId', v.bill_id
                        ))
                        FROM product_variants v
                        WHERE v.product_id = p.id
                    ),
                    '[]'::json
                ) as variants
            FROM products p
            WHERE p.business_id = $1
            ORDER BY p.created_at DESC;
        `;

        const result = await this.pool.query(query, [businessId]);
        return result.rows.map(row => ({
            ...row,
            price: parseFloat(row.price), // ensure numeric
            overallStatus: this.calculateOverallStatus(row.variants)
        }));
    }

    /**
     * Fetch a single product's detailed view by ID.
     */
    async getProductById(businessId: string, productId: string) {
        const query = `
            SELECT 
                p.id, p.name, p.brand, p.sku, p.category, p.description, p.price, p.color_index,
                (SELECT image_url FROM product_images WHERE product_id = p.id AND is_thumbnail = true LIMIT 1) as "imageUrl",
                COALESCE(
                    (
                        SELECT json_agg(json_build_object(
                            'id', v.id,
                            'size', v.size,
                            'stock', v.stock,
                            'status', v.status,
                            'lockedBy', v.locked_by,
                            'billId', v.bill_id
                        ))
                        FROM product_variants v
                        WHERE v.product_id = p.id
                    ),
                    '[]'::json
                ) as variants
            FROM products p
            WHERE p.business_id = $1 AND p.id = $2;
        `;

        const result = await this.pool.query(query, [businessId, productId]);
        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        return {
            ...row,
            price: parseFloat(row.price),
            overallStatus: this.calculateOverallStatus(row.variants)
        };
    }

    /**
     * Add a new product into the catalog, complete with base variants and image.
     */
    async addProduct(businessId: string, payload: any) {
        const { name, brand, sku, category, description, price, colorIndex, imageUrl, variants } = payload;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Insert product
            const pRes = await client.query(`
                INSERT INTO products (business_id, name, brand, sku, category, description, price, color_index)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id
            `, [businessId, name, brand, sku, category, description, price, colorIndex || 0]);

            const productId = pRes.rows[0].id;

            // 2. Insert variants
            if (variants && variants.length > 0) {
                for (const v of variants) {
                    await client.query(`
                        INSERT INTO product_variants (product_id, size, stock, status)
                        VALUES ($1, $2, $3, $4)
                    `, [productId, v.size, v.stock, v.status || 'available']);
                }
            } else {
                // Default 'One Size' variant if none provided
                await client.query(`
                    INSERT INTO product_variants (product_id, size, stock, status)
                    VALUES ($1, 'OS', 1, 'available')
                `, [productId]);
            }

            // 3. Insert Image if provided
            if (imageUrl) {
                await client.query(`
                    INSERT INTO product_images (product_id, image_url, is_thumbnail)
                    VALUES ($1, $2, true)
                `, [productId, imageUrl]);
            }

            await client.query('COMMIT');
            return {
                message: "Product added successfully",
                productId
            };

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    private calculateOverallStatus(variants: any[]): 'available' | 'locked' | 'sold' {
        if (!variants || variants.length === 0) return 'sold';

        let hasAvailable = false;
        let hasLocked = false;

        for (const v of variants) {
            if (v.status === 'available' && v.stock > 0) hasAvailable = true;
            if (v.status === 'locked') hasLocked = true;
        }

        if (hasAvailable) return 'available';
        if (hasLocked) return 'locked';
        return 'sold';
    }
}
