import { message } from './common.mjs';

function cellLabel(index) {
  let label = '';
  for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + (n - 1) % 26) + label;
  }
  return label;
}

export function grid(rows, truncated = false) {
  if (!rows.length) return message('This sheet is empty.');
  const container = document.createElement('div');
  container.className = 'preview-grid';
  const table = document.createElement('table');
  const visible = rows.slice(0, 500);
  const columns = Math.min(50, Math.max(...visible.map((row) => row.length)));
  const headers = table.createTHead().insertRow();
  for (let index = -1; index < columns; index++) {
    const header = document.createElement('th');
    header.scope = 'col';
    header.textContent = index < 0 ? '#' : cellLabel(index);
    headers.append(header);
  }
  const body = table.createTBody();
  for (const [index, values] of visible.entries()) {
    const row = body.insertRow();
    const header = document.createElement('th');
    header.scope = 'row';
    header.textContent = String(index + 1);
    row.append(header);
    for (let column = 0; column < columns; column++) {
      row.insertCell().textContent = String(values[column] ?? '');
    }
  }
  container.append(table);
  if (truncated || rows.length > 500 || visible.some((row) => row.length > 50)) {
    container.append(message('Showing up to 500 rows and 50 columns. Download the file for the full data.'));
  }
  return container;
}
