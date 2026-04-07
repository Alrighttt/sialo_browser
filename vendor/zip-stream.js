// Minimal streaming ZIP writer (store mode, no compression).
// Supports ZIP64 for files and archives larger than 4 GB.

function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; }

// Write a 64-bit value as two 32-bit little-endian words
function u64(v) {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, v & 0xFFFFFFFF, true);
  dv.setUint32(4, Math.floor(v / 0x100000000), true);
  return b;
}

const ZIP64_THRESHOLD = 0xFFFFFFFF;

export class ZipWriter {
  constructor(onData) {
    this._onData = onData;
    this._entries = [];
    this._offset = 0;
  }

  async startEntry(filename) {
    const name = new TextEncoder().encode(filename);
    this._current = { name, crc: 0xFFFFFFFF, size: 0, offset: this._offset };

    // Local file header (with data descriptor flag bit 3 set)
    // version needed = 45 for ZIP64
    const header = new Uint8Array(30 + name.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);  // local file header signature
    v.setUint16(4, 45, true);           // version needed (4.5 for ZIP64)
    v.setUint16(6, 0x0008, true);       // flags: bit 3 = data descriptor
    v.setUint16(8, 0, true);            // compression: store
    v.setUint16(10, 0, true);           // mod time
    v.setUint16(12, 0, true);           // mod date
    // crc, compressed size, uncompressed size = 0 (in data descriptor)
    v.setUint16(26, name.length, true);
    header.set(name, 30);

    await this._write(header);
  }

  async writeChunk(chunk) {
    this.updateCrc(chunk);
    await this._write(chunk);
  }

  // Update CRC and size without writing data.
  updateCrc(chunk) {
    const c = this._current;
    let crc = c.crc;
    for (let i = 0; i < chunk.length; i++) {
      crc ^= chunk[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    c.crc = crc;
    c.size += chunk.length;
  }

  // Account for bytes written externally (updates offset only).
  advanceOffset(n) {
    this._offset += n;
  }

  async endEntry() {
    const c = this._current;
    c.crc = (c.crc ^ 0xFFFFFFFF) >>> 0;
    c.needsZip64 = c.size > ZIP64_THRESHOLD;

    // ZIP64 data descriptor (24 bytes) or standard (16 bytes)
    if (c.needsZip64) {
      const desc = new Uint8Array(24);
      const v = new DataView(desc.buffer);
      v.setUint32(0, 0x08074b50, true);  // data descriptor signature
      v.setUint32(4, c.crc, true);
      // 64-bit compressed size
      v.setUint32(8, c.size & 0xFFFFFFFF, true);
      v.setUint32(12, Math.floor(c.size / 0x100000000), true);
      // 64-bit uncompressed size
      v.setUint32(16, c.size & 0xFFFFFFFF, true);
      v.setUint32(20, Math.floor(c.size / 0x100000000), true);
      await this._write(desc);
    } else {
      const desc = new Uint8Array(16);
      const v = new DataView(desc.buffer);
      v.setUint32(0, 0x08074b50, true);
      v.setUint32(4, c.crc, true);
      v.setUint32(8, c.size, true);
      v.setUint32(12, c.size, true);
      await this._write(desc);
    }

    this._entries.push(c);
    this._current = null;
  }

  async finish() {
    const cdOffset = this._offset;
    let cdSize = 0;

    for (const entry of this._entries) {
      const needsZip64 = entry.size > ZIP64_THRESHOLD || entry.offset > ZIP64_THRESHOLD;
      const extraLen = needsZip64 ? 28 : 0; // ZIP64 extra field: 2+2+8+8+8

      const rec = new Uint8Array(46 + entry.name.length + extraLen);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x02014b50, true);    // central directory signature
      v.setUint16(4, 45, true);             // version made by (4.5)
      v.setUint16(6, 45, true);             // version needed (4.5)
      v.setUint16(8, 0x0008, true);         // flags: data descriptor
      v.setUint16(10, 0, true);             // compression: store
      v.setUint16(12, 0, true);             // mod time
      v.setUint16(14, 0, true);             // mod date
      v.setUint32(16, entry.crc, true);

      if (needsZip64) {
        v.setUint32(20, 0xFFFFFFFF, true);  // compressed size placeholder
        v.setUint32(24, 0xFFFFFFFF, true);  // uncompressed size placeholder
      } else {
        v.setUint32(20, entry.size, true);
        v.setUint32(24, entry.size, true);
      }

      v.setUint16(28, entry.name.length, true);
      v.setUint16(30, extraLen, true);       // extra field length

      if (needsZip64) {
        v.setUint32(42, 0xFFFFFFFF, true);   // local header offset placeholder
      } else {
        v.setUint32(42, entry.offset, true);
      }

      rec.set(entry.name, 46);

      // ZIP64 extra field
      if (needsZip64) {
        const ext = 46 + entry.name.length;
        v.setUint16(ext, 0x0001, true);      // ZIP64 extended info tag
        v.setUint16(ext + 2, 24, true);      // size of extra data
        // 64-bit uncompressed size
        v.setUint32(ext + 4, entry.size & 0xFFFFFFFF, true);
        v.setUint32(ext + 8, Math.floor(entry.size / 0x100000000), true);
        // 64-bit compressed size
        v.setUint32(ext + 12, entry.size & 0xFFFFFFFF, true);
        v.setUint32(ext + 16, Math.floor(entry.size / 0x100000000), true);
        // 64-bit local header offset
        v.setUint32(ext + 20, entry.offset & 0xFFFFFFFF, true);
        v.setUint32(ext + 24, Math.floor(entry.offset / 0x100000000), true);
      }

      await this._write(rec);
      cdSize += rec.length;
    }

    const needsZip64End = cdOffset > ZIP64_THRESHOLD || this._entries.length > 0xFFFF;

    // ZIP64 end of central directory record
    if (needsZip64End || this._entries.some(e => e.needsZip64)) {
      const z64end = new Uint8Array(56);
      const v = new DataView(z64end.buffer);
      v.setUint32(0, 0x06064b50, true);    // ZIP64 end of CD signature
      // size of remaining record (44 bytes)
      v.setUint32(4, 44, true);
      v.setUint32(8, 0, true);
      v.setUint16(12, 45, true);            // version made by
      v.setUint16(14, 45, true);            // version needed
      v.setUint32(16, 0, true);             // disk number
      v.setUint32(20, 0, true);             // disk with CD
      // 64-bit total entries on this disk
      v.setUint32(24, this._entries.length & 0xFFFFFFFF, true);
      v.setUint32(28, 0, true);
      // 64-bit total entries
      v.setUint32(32, this._entries.length & 0xFFFFFFFF, true);
      v.setUint32(36, 0, true);
      // 64-bit CD size
      v.setUint32(40, cdSize & 0xFFFFFFFF, true);
      v.setUint32(44, Math.floor(cdSize / 0x100000000), true);
      // 64-bit CD offset
      v.setUint32(48, cdOffset & 0xFFFFFFFF, true);
      v.setUint32(52, Math.floor(cdOffset / 0x100000000), true);
      await this._write(z64end);

      // ZIP64 end of central directory locator
      const z64loc = new Uint8Array(20);
      const vl = new DataView(z64loc.buffer);
      vl.setUint32(0, 0x07064b50, true);   // ZIP64 locator signature
      vl.setUint32(4, 0, true);             // disk with ZIP64 EOCD
      // 64-bit offset of ZIP64 EOCD
      const z64endOffset = cdOffset + cdSize;
      vl.setUint32(8, z64endOffset & 0xFFFFFFFF, true);
      vl.setUint32(12, Math.floor(z64endOffset / 0x100000000), true);
      vl.setUint32(16, 1, true);            // total disks
      await this._write(z64loc);
    }

    // Standard end of central directory
    const eocd = new Uint8Array(22);
    const ve = new DataView(eocd.buffer);
    ve.setUint32(0, 0x06054b50, true);
    const entryCount = Math.min(this._entries.length, 0xFFFF);
    ve.setUint16(8, entryCount, true);
    ve.setUint16(10, entryCount, true);
    ve.setUint32(12, cdSize > ZIP64_THRESHOLD ? 0xFFFFFFFF : cdSize, true);
    ve.setUint32(16, cdOffset > ZIP64_THRESHOLD ? 0xFFFFFFFF : cdOffset, true);
    await this._write(eocd);
  }

  async _write(data) {
    this._offset += data.length;
    await this._onData(data);
  }
}
