const path = require('node:path');
const { openDrive } = require('./drive');
const { loadConfig } = require('./config-loader');

const { authMode } = loadConfig();
const identity = process.argv[2]?.trim();
if (authMode === 'passphrase') {
  console.error('Administrator access is available in account and IP modes.');
  process.exitCode = 1;
} else if (!identity) {
  console.error(`Usage: npm run grant-admin -- ${authMode === 'ip' ? 'client-ip' : 'username'}`);
  process.exitCode = 1;
} else {
  const data = path.resolve(process.env.FIRESEND_DATA_DIR || path.join(__dirname, '.data'));
  const db = openDrive(data);
  try {
    const sql = authMode === 'ip' ? "UPDATE drive_ip_users SET role = 'admin' WHERE ip = ?"
      : "UPDATE drive_accounts SET role = 'admin', disabled = 0 WHERE username = ?";
    const result = db.prepare(sql).run(identity);
    if (result.changes) console.log('Administrator access granted.');
    else {
      console.error('Register the account in FireSend first.');
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}
