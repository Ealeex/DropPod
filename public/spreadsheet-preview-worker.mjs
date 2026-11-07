import { read, utils } from '/vendor/preview/xlsx.mjs';

const maxRows = 500;
const maxColumns = 50;
let workbook;
let names;

self.onmessage = ({ data }) => {
  try {
    if (data.bytes) {
      workbook = read(data.bytes, { sheetRows: maxRows, cellHTML: false, cellFormula: false });
      names = workbook.SheetNames.filter((name, index) => !workbook.Workbook?.Sheets?.[index]?.Hidden);
      if (!names.length) throw new Error('No visible worksheets.');
      self.postMessage({ names });
      return;
    }
    const sheet = workbook.Sheets[names[data.index]];
    const range = sheet['!ref'] && utils.decode_range(sheet['!ref']);
    const full = sheet['!fullref'] ? utils.decode_range(sheet['!fullref']) : range;
    const rows = range ? utils.sheet_to_json(sheet, {
      header: 1, raw: false, defval: '', blankrows: true,
      range: { s: { r: 0, c: 0 }, e: { r: Math.min(maxRows - 1, range.e.r), c: Math.min(maxColumns - 1, range.e.c) } },
    }) : [];
    self.postMessage({ index: data.index, rows, truncated: full && (full.e.r >= maxRows || full.e.c >= maxColumns) });
  } catch {
    self.postMessage({ error: true });
  }
};
