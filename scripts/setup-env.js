// Create a private first-run configuration without replacing an existing deployment.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const destination = path.join(root, '.env');
const groups = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!_-'];
const alphabet = groups.join('');
const password = groups.map(group => group[crypto.randomInt(group.length)]);
while (password.length < 18) password.push(alphabet[crypto.randomInt(alphabet.length)]);
for (let i = password.length - 1; i > 0; i--) {
  const j = crypto.randomInt(i + 1);
  [password[i], password[j]] = [password[j], password[i]];
}
const values = {
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  ACCESS_GATE_SECRET: crypto.randomBytes(32).toString('hex'),
  ACCESS_GATE_PASSWORD: password.join('')
};
const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
const configuration = template.split('\n').map(line => {
  const separator = line.indexOf('=');
  const name = separator < 0 ? '' : line.slice(0, separator).trim();
  return Object.hasOwn(values, name) ? `${name}=${values[name]}` : line;
}).join('\n');
try {
  fs.writeFileSync(destination, configuration, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with independent random secrets. The public template disables the outer access gate.');
  console.log('To require a password, set ACCESS_GATE_ENABLED=true and use ACCESS_GATE_PASSWORD from .env.');
  console.log('Model, email and danmaku services are optional. Do not publish .env.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('.env already exists; no configuration was changed. Keep your existing settings.');
  } else {
    console.error(`Could not create .env: ${error.message}`);
  }
  process.exitCode = 1;
}
