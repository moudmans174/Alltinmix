/**
 * Command line tools:
 *   npm run migrate                                  apply database migrations
 *   npm run create-admin -- you@x.com "Your Name" "a-strong-password"
 */
const config = require('./config');
const db = require('./db');
const { hashPassword } = require('./lib/auth');

async function createUser(c, { name, email, password, role, tag }) {
  const { rows } = await c.query(
    `INSERT INTO users (name, email, password_hash, role, tag, email_verified_at) VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (lower(email)) DO UPDATE SET email_verified_at = COALESCE(users.email_verified_at, now()) RETURNING id`,
    [name, email.toLowerCase(), await hashPassword(password), role, tag || '']
  );
  return rows[0].id;
}

async function createAdmin(email, name, password) {
  if (!email || !name || !password) throw new Error('Usage: npm run create-admin -- you@example.com "Your Name" "a-strong-password"');
  if (password.length < 10) throw new Error('Use a password of at least 10 characters for an admin account.');
  await db.tx((c) => createUser(c, { name, email, password, role: 'admin', tag: 'Admin' }));
  console.log(`Admin account ready: ${email}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'migrate') {
    const applied = await db.migrate();
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
  } else if (cmd === 'create-admin') {
    await db.migrate();
    await createAdmin(...args);
  } else {
    console.log('Commands: migrate | create-admin <email> <name> <password>');
    process.exitCode = 1;
  }
  await db.pool.end();
}

main().catch(async (err) => {
  console.error(err.message);
  await db.pool.end().catch(() => {});
  process.exit(1);
});
