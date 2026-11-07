const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { execFile } = require("child_process");

function decodeXml(text) {
  return String(text || "")
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readZipEntry(buffer, name) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("DOCX 文件不完整");
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let offset = centralOffset;
  while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const entryName = buffer.slice(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("DOCX 本地头损坏");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.slice(dataStart, dataStart + compressedSize);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error("DOCX 使用了不支持的压缩方式");
  }
  throw new Error("DOCX 中找不到 word/document.xml");
}

function extractDocx(buffer) {
  return decodeXml(readZipEntry(buffer, "word/document.xml").toString("utf8"));
}

function extractPdf(buffer) {
  const text = [];
  const source = buffer.toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRe.exec(source))) {
    let raw = Buffer.from(match[1], "latin1");
    let content = "";
    try {
      content = zlib.inflateSync(raw).toString("latin1");
    } catch {
      content = raw.toString("latin1");
    }
    const textRe = /\((?:\\.|[^\\)])*\)\s*Tj|\[((?:\\.|[^\]])*)\]\s*TJ/g;
    let item;
    while ((item = textRe.exec(content))) {
      const fragment = item[1] || item[0];
      const strings = fragment.match(/\((?:\\.|[^\\)])*\)/g) || [];
      for (const value of strings) {
        text.push(
          value.slice(1, -1)
            .replace(/\\n/g, "\n")
            .replace(/\\r/g, "\n")
            .replace(/\\t/g, "\t")
            .replace(/\\\(/g, "(")
            .replace(/\\\)/g, ")")
            .replace(/\\\\/g, "\\")
        );
      }
    }
  }
  const result = text.join(" ").replace(/\s{2,}/g, " ").trim();
  if (!result) throw new Error("PDF 未提取到文字，可能是扫描件/图片 PDF；请上传可复制文字的 PDF 或 Word");
  return result;
}

function extractLegacyDoc(filePath) {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      const script = [
        "$ErrorActionPreference='Stop'",
        "$word=New-Object -ComObject Word.Application",
        "$word.Visible=$false",
        `$doc=$word.Documents.Open('${String(filePath).replace(/'/g, "''")}', $false, $true)`,
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
        "$doc.Content.Text",
        "$doc.Close($false)",
        "$word.Quit()",
      ].join("; ");
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message || "Word 文档解析失败，请另存为 .docx"));
        else resolve(String(stdout || "").trim());
      });
      return;
    }
    execFile("textutil", ["-convert", "txt", "-stdout", filePath], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message || "Word 文档解析失败，请另存为 .docx"));
      else resolve(String(stdout || "").trim());
    });
  });
}

async function extractDocument(buffer, fileName) {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  if ([".md", ".markdown", ".txt"].includes(ext)) return buffer.toString("utf8");
  if (ext === ".docx") return extractDocx(buffer);
  if (ext === ".pdf") return extractPdf(buffer);
  if (ext === ".doc") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobagent-doc-"));
    const filePath = path.join(dir, `resume${ext}`);
    try {
      fs.writeFileSync(filePath, buffer);
      return await extractLegacyDoc(filePath);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
    throw new Error("当前优先支持文档文本；图片简历需要 OCR，请先转成 Word/PDF/文本");
  }
  throw new Error(`暂不支持的文件类型：${ext || "未知"}`);
}

module.exports = { extractDocument, extractDocx, extractPdf, decodeXml };
