import { Pool } from 'pg';
import { Server } from 'socket.io';
export declare class LockingService {
    private db;
    private io;
    private readonly LOCK_TIMEOUT_MINUTES;
    constructor(db: Pool, io: Server);
    /**
     * [STEP 1: RESERVE]
     * Salesman soft-locks the item. Returns true if successfully claimed (First-to-Cloud).
     * Uses PostgreSQL 'FOR UPDATE SKIP LOCKED' to prevent thread blocking and instantly reject double-locks.
     */
    reserveItem(itemId: string, salesmanId: string): Promise<boolean>;
    /**
     * [STEP 2: TOKENIZE]
     * Salesman generates Bill ID. Once this executes, they lose edit access.
     */
    tokenizeBill(itemIds: string[], salesmanId: string): Promise<string>;
    /**
     * [STEP 3: VERIFY]
     * Owner 'Master Edit Power'. Owner finalizes bill and hard-deducts.
     * Optionally adjusts final items on the bill.
     */
    finalizeBill(billId: string, ownerId: string, finalItemIds: string[]): Promise<void>;
}
//# sourceMappingURL=LockingService.d.ts.map