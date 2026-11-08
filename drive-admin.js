const { isIP } = require('node:net');
const path = require('node:path');
const { openDrive } = require('./drive');
const { loadConfig } = require('./config-loader');

const { authMode } = loadConfig();
const identity = process.argv[2]?.trim();
if (authMode === 'passphrase') {
  console.error('Administrator access is available in account, IP, and off modes.');
  process.exitCode = 1;
} else if (!identity) {
  console.error(`Usage: npm run grant-admin -- ${authMode === 'account' ? 'username' : 'client-ip'}`);
  process.exitCode = 1;
} else if (authMode === 'off' && !isIP(identity)) {
  console.error('Enter a valid client IP address.');
  process.exitCode = 1;
} else {
  const data = path.resolve(process.env.FIRESEND_DATA_DIR || path.join(__dirname, '.data'));
  const db = openDrive(data);
  try {
    const sql = {
      off: 'INSERT OR IGNORE INTO drive_guest_admins (ip) VALUES (?)',
      ip: "UPDATE drive_ip_users SET role = 'admin' WHERE ip = ?",
      account: "UPDATE drive_accounts SET role = 'admin', disabled = 0 WHERE username = ?",
    }[authMode];
    const mapped = authMode === 'off' && /^::ffff:(.+)$/i.exec(identity);
    const address = mapped && isIP(mapped[1]) === 4 ? mapped[1] : identity;
    const result = db.prepare(sql).run(address);
    if (authMode === 'off' || result.changes) console.log('Administrator access granted.');
    else {
      console.error('Register the account in FireSend first.');
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}
