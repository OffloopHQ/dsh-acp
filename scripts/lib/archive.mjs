import { gzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";

function writeText(buffer, offset, length, value) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) throw new Error(`ustar field is too long: ${value}`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length >= length) throw new Error(`ustar numeric field is too large: ${value}`);
  writeText(buffer, offset, length, `${encoded}\0`);
}

function header(name, size, mode, mtime) {
  const buffer = Buffer.alloc(512);
  writeText(buffer, 0, 100, name);
  writeOctal(buffer, 100, 8, mode);
  writeOctal(buffer, 108, 8, 0);
  writeOctal(buffer, 116, 8, 0);
  writeOctal(buffer, 124, 12, size);
  writeOctal(buffer, 136, 12, mtime);
  buffer.fill(0x20, 148, 156);
  buffer[156] = "0".charCodeAt(0);
  writeText(buffer, 257, 6, "ustar\0");
  writeText(buffer, 263, 2, "00");
  writeText(buffer, 265, 32, "root");
  writeText(buffer, 297, 32, "root");
  const checksum = buffer.reduce((sum, byte) => sum + byte, 0);
  writeText(buffer, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return buffer;
}

/** Create a deterministic ustar+gzip archive without a platform tar dependency. */
export async function writeTarGzip(outputPath, entries, epochSeconds) {
  const chunks = [];
  const sorted = [...entries].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of sorted) {
    const content = entry.content ?? await readFile(entry.path);
    chunks.push(header(entry.name, content.length, entry.mode ?? 0o644, epochSeconds));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  const compressed = gzipSync(Buffer.concat(chunks), { level: 9 });
  compressed.fill(0, 4, 8);
  compressed[9] = 0xff;
  await writeFile(outputPath, compressed);
}
