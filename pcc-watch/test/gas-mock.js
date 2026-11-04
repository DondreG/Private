// Minimal in-memory stand-ins for the Apps Script services Code.gs uses, so
// the watcher can be run end to end under Node. Only what Code.gs calls is
// implemented.
'use strict';

const crypto = require('crypto');

function createGas(opts) {
  const tzDefault = (opts && opts.tz) || 'America/New_York';
  const files = {}; // id -> { kind: 'sheet'|'blob', name, updated, ss?, content? }
  const props = {};
  const mail = [];
  const logs = [];
  let triggers = [];
  let idSeq = 1;

  // -------------------------------------------------------------------------
  // Spreadsheet model
  // -------------------------------------------------------------------------
  class FakeRange {
    constructor(sheet, row, col, numRows, numCols) {
      Object.assign(this, { sheet, row, col, numRows, numCols });
    }
    getValues() {
      const out = [];
      for (let r = 0; r < this.numRows; r++) {
        const src = this.sheet.data[this.row - 1 + r] || [];
        const line = [];
        for (let c = 0; c < this.numCols; c++) {
          const v = src[this.col - 1 + c];
          line.push(v === undefined || v === null ? '' : v);
        }
        out.push(line);
      }
      return out;
    }
    getValue() { return this.getValues()[0][0]; }
    setValues(values) {
      if (values.length !== this.numRows || values.some((r) => r.length !== this.numCols)) {
        throw new Error('setValues: dimensions do not match the range');
      }
      values.forEach((r, i) => r.forEach((v, j) => this.sheet.set(this.row + i, this.col + j, v)));
      this.sheet.touch();
      return this;
    }
    setValue(v) { this.sheet.set(this.row, this.col, v); this.sheet.touch(); return this; }
  }
  ['setFontWeight', 'setFontSize', 'setFontColor', 'setBackground', 'setWrap', 'setNumberFormat',
    'setVerticalAlignment'].forEach((m) => { FakeRange.prototype[m] = function () { return this; }; });

  class FakeSheet {
    constructor(ss, name, data) {
      this.ss = ss;
      this.name = name;
      this.gid = idSeq++;
      this.data = data || [];
    }
    getName() { return this.name; }
    setName(n) { this.name = n; return this; }
    getSheetId() { return this.gid; }
    set(r, c, v) {
      while (this.data.length < r) this.data.push([]);
      const row = this.data[r - 1];
      while (row.length < c) row.push('');
      row[c - 1] = v;
    }
    touch() { this.ss.touch(); }
    getLastRow() {
      for (let r = this.data.length; r >= 1; r--) {
        if ((this.data[r - 1] || []).some((v) => v !== '' && v !== null && v !== undefined)) return r;
      }
      return 0;
    }
    getLastColumn() {
      let max = 0;
      this.data.forEach((row) => {
        for (let c = row.length; c >= 1; c--) {
          if (row[c - 1] !== '' && row[c - 1] !== null && row[c - 1] !== undefined) { max = Math.max(max, c); break; }
        }
      });
      return max;
    }
    getRange(row, col, numRows, numCols) {
      if (row < 1 || col < 1) throw new Error('getRange: row/col must be >= 1');
      if (numRows !== undefined && numRows < 1) throw new Error('getRange: numRows must be >= 1, got ' + numRows);
      if (numCols !== undefined && numCols < 1) throw new Error('getRange: numCols must be >= 1, got ' + numCols);
      return new FakeRange(this, row, col, numRows || 1, numCols || 1);
    }
    getDataRange() {
      return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
    }
    insertRowsAfter(after, n) {
      while (this.data.length < after) this.data.push([]);
      const blank = Array.from({ length: n }, () => []);
      this.data.splice(after, 0, ...blank);
      this.touch();
    }
    deleteRows(start, n) { this.data.splice(start - 1, n); this.touch(); }
    clear() { this.data = []; this.touch(); }
    setFrozenRows() {}
    setColumnWidth() {}
    autoResizeColumns() {}
  }

  class FakeSpreadsheet {
    constructor(id, name, tz) {
      this.id = id;
      this.name = name;
      this.tz = tz || tzDefault;
      this.sheets = [];
    }
    touch() { if (files[this.id]) files[this.id].updated = gas.clock(); }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
    getSpreadsheetTimeZone() { return this.tz; }
    getSheets() { return this.sheets.slice(); }
    getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
    insertSheet(name, index) {
      if (this.getSheetByName(name)) throw new Error('Sheet exists: ' + name);
      const s = new FakeSheet(this, name, []);
      if (index === undefined) this.sheets.push(s); else this.sheets.splice(index, 0, s);
      this.touch();
      return s;
    }
    deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); this.touch(); }
    addSheet(name, data) { const s = new FakeSheet(this, name, data); this.sheets.push(s); return s; }
  }

  // -------------------------------------------------------------------------
  // Drive
  // -------------------------------------------------------------------------
  function fakeFile(id) {
    const f = files[id];
    if (!f || f.trashed) throw new Error('File not found: ' + id);
    return {
      getId: () => id,
      getName: () => f.name,
      getLastUpdated: () => new Date(f.updated),
      getBlob: () => ({ getDataAsString: () => f.content }),
      setContent: (s) => { f.content = s; f.updated = gas.clock(); },
      moveTo: () => {},
    };
  }

  const DriveApp = {
    getFileById: (id) => fakeFile(id),
    searchFiles: (q) => {
      const m = q.match(/title contains '([^']*)'/);
      const needle = m ? m[1].toLowerCase() : '';
      const hits = Object.keys(files).filter((id) => files[id].kind === 'sheet' && !files[id].trashed &&
        files[id].name.toLowerCase().indexOf(needle) !== -1);
      let i = 0;
      return { hasNext: () => i < hits.length, next: () => fakeFile(hits[i++]) };
    },
    createFile: (name, content) => {
      const id = 'blob' + idSeq++;
      files[id] = { kind: 'blob', name, content, updated: gas.clock() };
      return fakeFile(id);
    },
    getFolderById: () => ({}),
  };

  const SpreadsheetApp = {
    openById: (id) => {
      if (gas.failOpen[id] > 0) {
        gas.failOpen[id]--;
        throw new Error('Service Spreadsheets failed while accessing document with id ' + id + '.');
      }
      const f = files[id];
      if (!f || f.kind !== 'sheet' || f.trashed || f.denied) throw new Error('No access to spreadsheet ' + id);
      return f.ss;
    },
    create: (name) => {
      const id = 'out' + idSeq++;
      const ss = new FakeSpreadsheet(id, name);
      files[id] = { kind: 'sheet', name, ss, updated: gas.clock() };
      ss.addSheet('Sheet1', []);
      return ss;
    },
  };

  // -------------------------------------------------------------------------
  // Utilities.formatDate (Java SimpleDateFormat subset)
  // -------------------------------------------------------------------------
  function parts(date, tz) {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
    });
    const p = {};
    f.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
    if (p.hour === '24') p.hour = '00';
    return p;
  }
  const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  function formatDate(date, tz, fmt) {
    if (!(date instanceof Date) || isNaN(date.getTime())) throw new Error('formatDate: bad date');
    const p = parts(date, tz);
    const H = Number(p.hour);
    const h12 = H % 12 === 0 ? 12 : H % 12;
    return fmt.replace(/yyyy|MM|dd|EEE|HH|hh|mm|ss|H|h|a|M|d|u/g, (t) => ({
      yyyy: p.year, MM: p.month, dd: p.day, EEE: p.weekday, HH: p.hour, hh: String(h12).padStart(2, '0'),
      mm: p.minute, ss: p.second, H: String(H), h: String(h12), a: H < 12 ? 'AM' : 'PM',
      M: String(Number(p.month)), d: String(Number(p.day)), u: String(DOW[p.weekday]),
    })[t]);
  }

  const Utilities = {
    computeHmacSha256Signature: (value, key) =>
      Array.from(crypto.createHmac('sha256', key).update(value, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => crypto.randomUUID(),
    sleep: () => {},
    formatDate,
  };

  const gas = {
    now: new Date('2026-11-04T12:05:00Z'),
    failOpen: {},
    mailDown: false,
    clock() { return gas.now.getTime(); },
    files,
    props,
    mail,
    logs,
    get triggers() { return triggers; },
    FakeSpreadsheet,
    addSpreadsheet(id, name, tz) {
      const ss = new FakeSpreadsheet(id, name, tz);
      files[id] = { kind: 'sheet', name, ss, updated: gas.clock() };
      return ss;
    },
    touch(id) { files[id].updated = gas.clock(); },
    formatDate,
    context: {
      DriveApp,
      SpreadsheetApp,
      Utilities,
      Session: {
        getScriptTimeZone: () => tzDefault,
        getEffectiveUser: () => ({ getEmail: () => 'dondre.test@example.test' }),
      },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k) => (k in props ? props[k] : null),
          setProperty: (k, v) => { props[k] = String(v); },
          deleteProperty: (k) => { delete props[k]; },
        }),
      },
      LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
      MailApp: {
        sendEmail: (o) => {
          if (gas.mailDown) throw new Error('Service invoked too many times for one day: email.');
          mail.push(Object.assign({ at: new Date(gas.now) }, o));
        },
      },
      ScriptApp: {
        getProjectTriggers: () => triggers.slice(),
        deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
        newTrigger: (fn) => {
          const t = { fn, getHandlerFunction: () => fn };
          const chain = { timeBased: () => chain, everyMinutes: (n) => { t.every = n; return chain; },
            create: () => { triggers.push(t); return t; } };
          return chain;
        },
      },
      Logger: { log: (m) => logs.push(String(m)) },
      MimeType: { PLAIN_TEXT: 'text/plain' },
    },
  };
  return gas;
}

module.exports = { createGas };
