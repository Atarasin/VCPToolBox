'use strict';

/**
 * 零依赖 ZIP（STORE，不压缩）打包器。
 *
 * 仅供 skill 导出下载使用：entry 全部是 skill generator 产出的 UTF-8 文本，
 * 数量固定三个、体积小，压缩没有收益；避免为一次下载引入 zip 依赖。
 * 结构参照 PKWARE APPNOTE：本地文件头 + 中央目录 + EOCD，文件名按 UTF-8
 * 标记（通用位标志 bit 11），CRC32 用本地实现（不依赖 Node 版本特性）。
 *
 * 时间戳固定为 ZIP 纪元 1980-01-01 00:00:00：导出物自身没有时间语义
 * （生成时间记录在 INSTALL.md / manifest.json 里），固定值让同一 artifact
 * 产出的 zip 字节级可复现，便于内容哈希比对与测试。
 */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let value = n;
        for (let bit = 0; bit < 8; bit += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[n] = value;
    }
    return table;
})();

function crc32(buffer) {
    let crc = -1;
    for (let index = 0; index < buffer.length; index += 1) {
        crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}

// 1980-01-01：date = (year-1980)<<9 | month<<5 | day，time = 0（00:00:00）
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIR_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const UTF8_FLAG = 0x0800;

function validateEntryPath(path) {
    if (typeof path !== 'string' || path.length === 0) {
        throw new TypeError('zip entry path must be a non-empty string');
    }
    if (path.includes('\\') || path.startsWith('/')) {
        throw new TypeError(`zip entry path must be relative posix path: "${path}"`);
    }
    const segments = path.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new TypeError(`zip entry path must not contain empty/../. segments: "${path}"`);
    }
}

function buildLocalFileHeader({ nameBytes, data, crc }) {
    const header = Buffer.alloc(LOCAL_FILE_HEADER_SIZE);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_FLAG, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    return header;
}

function buildCentralDirectoryHeader({ nameBytes, data, crc, localHeaderOffset }) {
    const header = Buffer.alloc(CENTRAL_DIR_HEADER_SIZE);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8_FLAG, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(localHeaderOffset, 42);
    return header;
}

/**
 * @param {Array<{path: string, content: string | Buffer}>} entries
 * @returns {Buffer} 完整 zip 字节流
 */
function buildZipArchive(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new TypeError('buildZipArchive requires a non-empty entries array');
    }
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;
    for (const entry of entries) {
        validateEntryPath(entry.path);
        const nameBytes = Buffer.from(entry.path, 'utf8');
        const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
        const crc = crc32(data);
        localChunks.push(
            buildLocalFileHeader({ nameBytes, data, crc }),
            nameBytes,
            data
        );
        centralChunks.push(
            buildCentralDirectoryHeader({ nameBytes, data, crc, localHeaderOffset: offset }),
            nameBytes
        );
        offset += LOCAL_FILE_HEADER_SIZE + nameBytes.length + data.length;
    }

    const centralDirectory = Buffer.concat(centralChunks);
    const eocd = Buffer.alloc(EOCD_SIZE);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDirectory.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

module.exports = { buildZipArchive, crc32 };
