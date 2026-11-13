import crypto from 'node:crypto';

/**
 * Seals small secrets (OAuth tokens) before they go into the database, so a copy of the database
 * file alone does not give them away. The key is derived from the server's secret: with a different
 * secret, or a text that was altered, `open` answers null.
 */
export function secretBox(secret: string) {
  const key = crypto.createHmac('sha256', secret).update('secretbox:v1').digest();
  return {
    seal(plain: string): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
    },
    open(sealed: string): string | null {
      if (!sealed.startsWith('v1.')) return null;
      try {
        const raw = Buffer.from(sealed.slice(3), 'base64url');
        if (raw.length < 28) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}
