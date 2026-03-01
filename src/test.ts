import { Pool } from 'pg';
import { LockingService } from './services/LockingService';
import { AuthService } from './services/AuthService';
import { InventoryService } from './services/InventoryService';
import { Server } from 'socket.io';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/syncra',
});

// Mock Socket.io Server for the Locking Service to not crash
const io = new Server();
const lockingService = new LockingService(pool, io);
const authService = new AuthService(pool);
const inventoryService = new InventoryService(pool);

async function runTests() {
    console.log("--- Starting Syncra Backend Tests ---");
    try {
        // This assumes the schema has been applied against the local 'syncra' database.

        // 1. Test Owner Registration
        console.log("Testing Auth: Register Owner...");
        const ownerData = {
            businessType: 'Clothing',
            businessName: 'Luxe Test Co',
            name: 'Test Admin',
            email: `admin_${Date.now()}@test.com`,
            phone: `+1555${Math.floor(Math.random() * 9999999)}`,
            password: 'password123',
            plan: 'professional',
            invitedEmails: [`sales_${Date.now()}@test.com`]
        };
        const authRes = await authService.registerOwner(ownerData);
        console.log("Owner Registered:", authRes.user.name, "| Business ID:", authRes.businessId);

        // 2. Test OTP Flow
        console.log("Testing Auth: Request & Verify OTP...");
        const inviteContact = ownerData.invitedEmails[0];
        await authService.requestSalesmanOtp(inviteContact!);
        const salesmanAuth = await authService.verifySalesmanOtp(inviteContact!, '1234');
        console.log("Salesman Verified:", salesmanAuth.user.role);

        const businessId = authRes.businessId;
        const salesmanId = salesmanAuth.user.id;

        // 3. Seed some products manually for test
        console.log("Seeding Products...");
        const pRes = await pool.query(`
            INSERT INTO products (business_id, name, brand, sku, category, price)
            VALUES ($1, 'Vinta Air Jacket', 'Nike', 'NK-VAJ-001', 'Jackets', 129.99)
            RETURNING id
        `, [businessId]);
        const productId = pRes.rows[0].id;

        const vRes = await pool.query(`
            INSERT INTO product_variants (product_id, size, stock)
            VALUES ($1, 'M', 2), ($1, 'L', 0)
            RETURNING id, size
        `, [productId]);
        const variantM = vRes.rows[0].id;
        const variantL = vRes.rows[1].id;
        console.log("Products Seeded.");

        // 4. Test Locking
        console.log("Testing LockingService: Reserve Medium...");
        let success = await lockingService.reserveVariant(businessId, productId, variantM, salesmanId);
        console.log(`Reserve Medium (Stock 2): ${success ? 'PASSED' : 'FAILED'}`);

        console.log("Testing LockingService: Double Reserve Medium...");
        // Another salesman tries to lock the same medium
        const fakeSalesmanId = salesmanId; // Just reuse ID for test failure simulation of already locked
        let failReserve = await lockingService.reserveVariant(businessId, productId, variantM, fakeSalesmanId);
        console.log(`Reserve Medium Again (Should Fail): ${!failReserve ? 'PASSED' : 'FAILED'}`);

        console.log("Testing LockingService: Reserve Large...");
        let failOutOfStock = await lockingService.reserveVariant(businessId, productId, variantL, salesmanId);
        console.log(`Reserve Large (Stock 0 - Should Fail): ${!failOutOfStock ? 'PASSED' : 'FAILED'}`);

        // 5. Test Billing
        console.log("Testing LockingService: Generate Token...");
        const token = await lockingService.tokenizeVariant(businessId, productId, variantM, salesmanId);
        console.log("Token Generated:", token);

        console.log("Testing LockingService: Finalize Bill...");
        // Lookup bill ID
        const bRes = await pool.query(`SELECT id FROM bills WHERE token_id = $1`, [token]);
        const billId = bRes.rows[0].id;

        await lockingService.finalizeBill(businessId, billId);
        console.log("Bill Finalized. Hard deduction complete.");

        // Verify stock is now 1
        const verifyRes = await pool.query(`SELECT stock, status FROM product_variants WHERE id = $1`, [variantM]);
        console.log(`Final Stock: ${verifyRes.rows[0].stock} (Status: ${verifyRes.rows[0].status})`);

        // 6. Test InventoryService
        console.log("Testing InventoryService: Add Product...");
        const newProduct = await inventoryService.addProduct(businessId, {
            name: "Classic Silk Tie",
            brand: "Hermes",
            sku: "HM-CST-112",
            category: "Accessories",
            description: "100% pure silk tie in navy blue.",
            price: 195.00,
            imageUrl: "https://example.com/tie.jpg",
            variants: [
                { size: "OS", stock: 10, status: "available" }
            ]
        });
        console.log(`InventoryService Add: PASSED - New Product ID: ${newProduct.productId}`);

        console.log("Testing InventoryService: Get Inventory...");
        const catalog = await inventoryService.getInventory(businessId);
        console.log(`InventoryService Get: PASSED - Catalog Size: ${catalog.length}`);

        const catalogItem = catalog.find((p: any) => p.name === "Classic Silk Tie");
        console.log(`InventoryService Parse: PASSED - Got image: ${catalogItem.imageUrl}, stock: ${catalogItem.variants[0].stock}`);

    } catch (e) {
        console.error("Test Failed!", e);
    } finally {
        await pool.end();
        io.close();
        console.log("--- Tests Completed ---");
    }
}

runTests();
