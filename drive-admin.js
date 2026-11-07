const path = require('node:path');
const { openDrive } = require('./drive');

const username = process.argv[2]?.trim();
if (!username) {
  console.error('Usage: npm run grant-admin -- username');
  process.exitCode = 1;
} else {
  const data = path.resolve(process.env.FIRESEND_DATA_DIR || path.join(__dirname, '.data'));
  const db = openDrive(data);
  try {
    const result = db.prepare("UPDATE drive_accounts SET role = 'admin', disabled = 0 WHERE username = ?").run(username);
    if (result.changes) console.log('Administrator access granted.');
    else {
      console.error('Register the account in FireSend first.');
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}
