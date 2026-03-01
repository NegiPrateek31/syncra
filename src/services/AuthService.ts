import { Pool } from 'pg';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'syncra-super-secret-key';

export class AuthService {
    constructor(private db: Pool) { }

    async registerOwner(data: any): Promise<any> {
        const { businessType, businessName, name, email, phone, password, plan, invitedEmails } = data;
        const client = await this.db.connect();

        try {
            await client.query('BEGIN');

            // 1. Create Business
            const bizRes = await client.query(`
                INSERT INTO businesses (name, type, subscription, trial_ends_at)
                VALUES ($1, $2, $3, NOW() + INTERVAL '1 month')
                RETURNING id
            `, [businessName, businessType, plan]);
            const businessId = bizRes.rows[0].id;

            // 2. Create Owner User
            // In a real app we would bcrypt the password here
            const userRes = await client.query(`
                INSERT INTO users (business_id, name, email, phone, role, password_hash)
                VALUES ($1, $2, $3, $4, 'owner', $5)
                RETURNING id, name, role
            `, [businessId, name, email, phone, password]);
            const owner = userRes.rows[0];

            // 3. Queue Invites
            if (invitedEmails && invitedEmails.length > 0) {
                for (const contact of invitedEmails) {
                    await client.query(`
                        INSERT INTO invites (business_id, contact)
                        VALUES ($1, $2)
                    `, [businessId, contact]);
                }
            }

            await client.query('COMMIT');

            const token = jwt.sign({ id: owner.id, role: owner.role, businessId }, JWT_SECRET, { expiresIn: '7d' });
            return { token, user: owner, businessId };

        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async requestSalesmanOtp(contact: string): Promise<any> {
        // Find if invite exists
        const { rows } = await this.db.query(`
            SELECT id, business_id FROM invites 
            WHERE contact = $1 AND is_accepted = FALSE
        `, [contact]);

        if (rows.length === 0) {
            // Also check if already a user
            const exists = await this.db.query(`SELECT id FROM users WHERE email = $1 OR phone = $1`, [contact]);
            if (exists.rows.length === 0) {
                throw new Error("No active invitation found for this contact.");
            }
            // If already a user, we'd still generate an OTP to login, skipping the logic here for brevity
            // For now, generating a fake OTP 1234
            return { message: "OTP Sent" };
        }

        const invite = rows[0];
        // Generate Mock OTP (always 1234 for testing)
        // In real app, send via Twilio/SendGrid
        await this.db.query(`
            UPDATE invites SET otp = '1234', otp_expires_at = NOW() + INTERVAL '10 minutes'
            WHERE id = $1
        `, [invite.id]);

        return { message: "OTP Sent (Use 1234)" };
    }

    async verifySalesmanOtp(contact: string, otp: string): Promise<any> {
        // Checking invites
        const inviteRes = await this.db.query(`
            SELECT id, business_id, otp, otp_expires_at FROM invites 
            WHERE contact = $1 AND is_accepted = FALSE
        `, [contact]);

        if (inviteRes.rows.length > 0) {
            const invite = inviteRes.rows[0];
            if (invite.otp !== otp || new Date() > new Date(invite.otp_expires_at)) {
                throw new Error("Invalid or expired OTP");
            }

            // Valid! Create User
            const userRes = await this.db.query(`
                INSERT INTO users (business_id, name, email, role)
                VALUES ($1, $2, $3, 'salesman')
                RETURNING id, name, role
            `, [invite.business_id, contact, contact.includes('@') ? contact : null]);
            const salesman = userRes.rows[0];

            // Mark invite accepted
            await this.db.query(`UPDATE invites SET is_accepted = TRUE WHERE id = $1`, [invite.id]);

            const token = jwt.sign({ id: salesman.id, role: salesman.role, businessId: invite.business_id }, JWT_SECRET, { expiresIn: '14d' });
            return { token, user: salesman, businessId: invite.business_id };
        }

        // Checking existing login
        const userRes = await this.db.query(`
            SELECT id, business_id, role, name FROM users WHERE email = $1 OR phone = $1
        `, [contact]);

        if (userRes.rows.length > 0) {
            // Assume OTP was valid for existing user for now (e.g. 1234)
            if (otp !== '1234') throw new Error("Invalid OTP");
            const salesman = userRes.rows[0];
            const token = jwt.sign({ id: salesman.id, role: salesman.role, businessId: salesman.business_id }, JWT_SECRET, { expiresIn: '14d' });
            return { token, user: salesman, businessId: salesman.business_id };
        }

        throw new Error("User not found.");
    }
}
