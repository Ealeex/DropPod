const path = require('node:path');
const { readFileSync } = require('node:fs');

const themes = new Set(['vista', 'graphite']);
const authModes = new Set(['account', 'passphrase', 'ip', 'off']);

function stripJsonComments(source) {
  let result = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index++;
      } else if (character === '\n') {
        result += character;
      }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index++;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index++;
      continue;
    }
    result += character;
  }
  return result;
}

function stripTrailingCommas(source) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead++;
      if (source[lookahead] === '}' || source[lookahead] === ']') continue;
    }
    result += character;
  }
  return result;
}

function loadConfig() {
  let raw = {};
  try {
    const source = readFileSync(path.join(__dirname, 'config.jsonc'), 'utf8');
    raw = JSON.parse(stripTrailingCommas(stripJsonComments(source)));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read config.jsonc:', error.message);
  }

  if (raw['auth-mode'] !== undefined && !authModes.has(raw['auth-mode'])) {
    console.error('Unknown auth-mode in config.jsonc; using "account".');
  }
  return {
    defaultTheme: themes.has(raw['default-theme']) ? raw['default-theme'] : 'vista',
    authMode: authModes.has(raw['auth-mode']) ? raw['auth-mode'] : 'account',
    trustedProxies: raw['trusted-proxies'] === undefined ? [] : raw['trusted-proxies'],
  };
}

module.exports = { loadConfig, stripJsonComments, stripTrailingCommas };
