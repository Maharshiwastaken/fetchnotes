'use strict';

/**
 * Minimal RFC-4180 CSV parser/writer.
 *
 * Spotify's export needs full quote handling: fields are quoted, titles can
 * contain commas, and 90 rows across these files contain literal " inside a
 * quoted field (escaped as ""). A naive split(',') silently corrupts those.
 *
 * Handles: quoted fields, "" escapes, embedded commas, \r\n and \n, UTF-8 BOM.
 */

const fs = require('node:fs');

/**
 * Parse CSV text into an array of row objects keyed by header.
 * Blank lines are skipped. Rows with fewer fields than the header are
 * padded with '' so every row exposes the same keys.
 */
function parseCsv(text) {
  // Strip UTF-8 BOM — Spotify writes one, and it otherwise corrupts the
  // first header name ("Track URI" becomes "\ufeffTrack URI").
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let started = false; // true once the current record has any content

  const pushField = () => {
    record.push(field);
    field = '';
  };

  const pushRecord = () => {
    pushField();
    // Skip entirely blank lines (record of one empty field, no content).
    if (!(record.length === 1 && record[0] === '')) rows.push(record);
    record = [];
    started = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        // "" inside quotes is a literal quote; a lone " ends the field.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ',') {
      pushField();
      started = true;
    } else if (ch === '\n') {
      pushRecord();
    } else if (ch === '\r') {
      // \r\n -> let the following \n handle the record break.
      if (text[i + 1] === '\n') {
        i += 1;
      }
      pushRecord();
    } else {
      field += ch;
      started = true;
    }
  }

  // Flush trailing field/record if the file didn't end with a newline.
  if (inQuotes || field !== '' || record.length > 0 || started) pushRecord();

  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((raw) => {
    const obj = {};
    for (let c = 0; c < header.length; c += 1) {
      obj[header[c]] = raw[c] !== undefined ? raw[c] : '';
    }
    return obj;
  });
}

function readCsv(filePath) {
  return parseCsv(fs.readFileSync(filePath, 'utf8'));
}

/** Escape a value for CSV output, quoting when needed. */
function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  const head = columns.join(',');
  const body = rows.map((r) => columns.map((c) => csvField(r[c])).join(','));
  return `${[head, ...body].join('\n')}\n`;
}

function writeCsv(filePath, rows, columns) {
  fs.writeFileSync(filePath, toCsv(rows, columns), 'utf8');
}

module.exports = { parseCsv, readCsv, toCsv, writeCsv, csvField };
