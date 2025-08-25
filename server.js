
/**
 * Smallpdf-like All-in-One Server (MVP)
 * Tools:
 *  - merge, split, compress, images->pdf, doc/ppt/xls->pdf
 *  - unlock (remove password using known password)
 *  - annotate (text/highlight rectangles)
 *  - sign (overlay signature image)
 *  - pdf->docx (with optional OCR using tesseract + ghostscript)
 *  - passport photo maker (bg remove via rembg CLI if available)
 *
 * External optional CLI deps:
 *   - Ghostscript `gs` (compress, pdf rasterization for OCR)
 *   - LibreOffice (`soffice`) via libreoffice-convert (office->pdf, pdf->docx basic)
 *   - rembg (background removal)  https://github.com/danielgatis/rembg
 *   - tesseract (OCR)            https://tesseract-ocr.github.io/
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const sharp = require("sharp");
const libre = require("libreoffice-convert");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { Document, Packer, Paragraph } = require("docx");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

const TMP = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, TMP),
  filename: (_, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage });

function cleanup(file) { try{ fs.unlinkSync(file); } catch{} }
function sendAndCleanup(res, filePath, name) {
  res.download(filePath, name, () => cleanup(filePath));
}
function which(cmd) {
  return new Promise((resolve)=>{
    exec(process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`, (err, stdout)=> resolve(!err && !!stdout));
  });
}

/** MERGE */
app.post("/api/merge", upload.array("files", 30), async (req, res) => {
  try {
    if ((req.files||[]).length < 2) return res.status(400).json({ error: "Upload at least 2 PDFs" });
    const out = await PDFDocument.create();
    for (const f of req.files) {
      const pdf = await PDFDocument.load(fs.readFileSync(f.path));
      const pages = await out.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(p=>out.addPage(p)); cleanup(f.path);
    }
    const bytes = await out.save();
    const outPath = path.join(TMP, uuidv4()+".pdf"); fs.writeFileSync(outPath, bytes);
    sendAndCleanup(res, outPath, "merged.pdf");
  } catch(e){ console.error(e); res.status(500).json({ error: "Merge failed" }); }
});

/** SPLIT */
app.post("/api/split", upload.single("file"), async (req, res) => {
  try {
    const s = Math.max(1, parseInt(req.body.start||"1"));
    const e = Math.max(s, parseInt(req.body.end||`${s}`));
    const src = await PDFDocument.load(fs.readFileSync(req.file.path));
    const out = await PDFDocument.create();
    const idxs = Array.from({length: Math.min(e, src.getPageCount()) - (s-1)}, (_,i)=> i + (s-1));
    const pages = await out.copyPages(src, idxs);
    pages.forEach(p=>out.addPage(p));
    const bytes = await out.save(); const outPath = path.join(TMP, uuidv4()+".pdf"); fs.writeFileSync(outPath, bytes);
    cleanup(req.file.path); sendAndCleanup(res, outPath, `split_${s}-${e}.pdf`);
  } catch(e){ console.error(e); res.status(500).json({ error: "Split failed" }); }
});

/** IMAGES -> PDF */
app.post("/api/images-to-pdf", upload.array("files", 60), async (req, res) => {
  try{
    const pdf = await PDFDocument.create();
    for (const f of req.files) {
      const buf = await sharp(f.path).jpeg({ quality: 92 }).toBuffer();
      const img = await pdf.embedJpg(buf);
      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, { x:0, y:0, width: img.width, height: img.height });
      cleanup(f.path);
    }
    const bytes = await pdf.save();
    const outPath = path.join(TMP, uuidv4()+".pdf"); fs.writeFileSync(outPath, bytes);
    sendAndCleanup(res, outPath, "images_to_pdf.pdf");
  } catch(e){ console.error(e); res.status(500).json({ error: "Convert failed" }); }
});

/** OFFICE -> PDF via LibreOffice */
app.post("/api/office-to-pdf", upload.single("file"), async (req, res) => {
  try{
    if (!req.file) return res.status(400).json({ error:"Upload a DOC/DOCX/PPT/XLS file" });
    libre.convert(fs.readFileSync(req.file.path), ".pdf", undefined, (err, done)=>{
      cleanup(req.file.path);
      if (err){ console.error(err); return res.status(500).json({ error:"LibreOffice not installed or failed" }); }
      const outPath = path.join(TMP, uuidv4()+".pdf"); fs.writeFileSync(outPath, done);
      sendAndCleanup(res, outPath, "converted.pdf");
    });
  } catch(e){ console.error(e); res.status(500).json({ error:"Conversion failed" }); }
});

/** COMPRESS via Ghostscript */
app.post("/api/compress", upload.single("file"), async (req, res) => {
  const has = await which("gs");
  if (!has){ cleanup(req.file?.path||""); return res.status(500).json({ error: "Ghostscript not installed" }); }
  const input = req.file.path, output = path.join(TMP, uuidv4()+".pdf");
  const setting = req.body.quality || "/screen";
  const cmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${setting} -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${output}" "${input}"`;
  exec(cmd, (err)=>{
    cleanup(input);
    if (err) return res.status(500).json({ error: "Compression failed" });
    sendAndCleanup(res, output, "compressed.pdf");
  });
});

/** UNLOCK using known password */
app.post("/api/unlock", upload.single("file"), async (req, res) => {
  try{
    const pass = req.body.password || "";
    const src = await PDFDocument.load(fs.readFileSync(req.file.path), { password: pass });
    // saving removes encryption
    const bytes = await src.save();
    const outPath = path.join(TMP, uuidv4()+".pdf"); fs.writeFileSync(outPath, bytes);
    cleanup(req.file.path); sendAndCleanup(res, outPath, "unlocked.pdf");
  }catch(e){
    console.error(e); res.status(400).json({ error: "Wrong password or unsupported encryption" });
  }
});

/** ANNOTATE: draw simple text and highlight rects */
app.post("/api/annotate", upload.single("file"), async (req, res) => {
  try{
    const { annotations } = req.body;
    const ann = JSON.parse(annotations||"[]");
    const pdf = await PDFDocument.load(fs.readFileSync(req.file.path));
    for (const a of ann) {
      const page = pdf.getPage(Math.max(0, (a.page||1)-1));
      if (a.type === "text") {
        const font = await pdf.embedFont(StandardFonts.Helvetica);
        page.drawText(a.value||"", { x: a.x||50, y: a.y||50, size: a.size||12, color: rgb(0,0,0), font });
      } else if (a.type === "highlight") {
        page.drawRectangle({ x:a.x||40, y:a.y||40, width:a.w||100, height:a.h||20, color: rgb(1,1,0), opacity: 0.4 });
      }
    }
    const bytes = await pdf.save();
    const outPath = path.join(TMP, uuidv4()+".pdf"); fs.writeFileSync(outPath, bytes);
    cleanup(req.file.path); sendAndCleanup(res, outPath, "annotated.pdf");
  } catch(e){ console.error(e); res.status(500).json({ error:"Annotate failed" }); }
});

/** SIGN: overlay signature image (png with transparency recommended) */
app.post("/api/sign", upload.fields([{name:"file", maxCount:1},{name:"signature", maxCount:1}]), async (req, res) => {
  try{
    const pageNo = parseInt(req.body.page||"1") - 1;
    const x = parseFloat(req.body.x||"50"), y = parseFloat(req.body.y||"50");
    const w = parseFloat(req.body.w||"150");
    const pdf = await PDFDocument.load(fs.readFileSync(req.files.file[0].path));
    const sigBuf = fs.readFileSync(req.files.signature[0].path);
    // ensure PNG
    const pngBuf = await sharp(sigBuf).png().toBuffer();
    const png = await pdf.embedPng(pngBuf);
    const page = pdf.getPage(Math.max(0, Math.min(pageNo, pdf.getPageCount()-1)));
    const scale = w / png.width;
    const h = png.height * scale;
    page.drawImage(png, { x, y, width: w, height: h });
    const bytes = await pdf.save();
    const outPath = path.join(TMP, uuidv4()+".pdf"); fs.writeFileSync(outPath, bytes);
    cleanup(req.files.file[0].path); cleanup(req.files.signature[0].path);
    sendAndCleanup(res, outPath, "signed.pdf");
  } catch(e){ console.error(e); res.status(500).json({ error:"Sign failed" }); }
});

/** PDF -> DOCX with optional OCR */
app.post("/api/pdf-to-docx", upload.single("file"), async (req, res) => {
  try{
    const useOcr = (req.body.ocr||"false") === "true";
    const input = req.file.path;

    // First, try LibreOffice direct conversion (fast, no OCR)
    if (!useOcr) {
      libre.convert(fs.readFileSync(input), ".docx", undefined, (err, done)=>{
        cleanup(input);
        if (err){ console.error(err); return res.status(500).json({ error:"LibreOffice not installed or failed" }); }
        const outPath = path.join(TMP, uuidv4()+".docx"); fs.writeFileSync(outPath, done);
        sendAndCleanup(res, outPath, "converted.docx");
      });
      return;
    }

    // OCR path: requires ghostscript and tesseract
    const hasGS = await which("gs"); const hasTess = await which("tesseract");
    if (!hasGS || !hasTess) { cleanup(input); return res.status(500).json({ error:"Install ghostscript and tesseract for OCR" }); }

    // Render PDF to PNGs via ghostscript
    const outDir = path.join(TMP, uuidv4());
    fs.mkdirSync(outDir);
    const pngBase = path.join(outDir, "page");
    const cmd = `gs -dNOPAUSE -dBATCH -sDEVICE=png16m -r300 -sOutputFile="${pngBase}-%03d.png" "${input}"`;
    await new Promise((resolve, reject)=> exec(cmd, (err)=> err?reject(err):resolve()));
    cleanup(input);

    // OCR each page
    const texts = [];
    const files = fs.readdirSync(outDir).filter(f=>f.endsWith(".png")).sort();
    for (const f of files) {
      const p = path.join(outDir, f);
      const outTxt = p.replace(".png", ".txt");
      await new Promise((resolve)=> {
        exec(`tesseract "${p}" "${p.replace(".png","")}" -l eng`, ()=> resolve());
      });
      texts.push(fs.existsSync(outTxt) ? fs.readFileSync(outTxt, "utf8") : "");
    }
    // Build DOCX
    const doc = new Document({ sections: [{ properties: {}, children: texts.join("\n\n").split("\n").map(t=> new Paragraph(t)) }] });
    const outBuf = await Packer.toBuffer(doc);
    const outPath = path.join(TMP, uuidv4()+".docx"); fs.writeFileSync(outPath, outBuf);

    // cleanup pngs
    for (const f of fs.readdirSync(outDir)) cleanup(path.join(outDir, f));
    fs.rmdirSync(outDir);
    sendAndCleanup(res, outPath, "ocr.docx");
  } catch(e){ console.error(e); res.status(500).json({ error:"PDF->DOCX failed" }); }
});

/** Passport Photo Maker */
app.post("/api/passport", upload.single("file"), async (req, res) => {
  try{
    const bg = req.body.bg || "white"; // white, blue, red, green (css color names or hex)
    const copies = parseInt(req.body.copies||"8"); // how many on A4
    const useRemove = (req.body.removeBg||"true") === "true";

    const input = req.file.path;
    let img = sharp(input).resize({ width: 1063, height: 1417, fit: "cover" }); // 3.5x4.5cm @ 300dpi
    let buf = await img.png().toBuffer();

    // try rembg if available
    if (useRemove) {
      const hasRembg = await which("rembg");
      if (hasRembg) {
        const out = path.join(TMP, uuidv4()+".png");
        await new Promise((resolve)=> exec(`rembg i "${input}" "${out}"`, ()=> resolve()));
        if (fs.existsSync(out)) { buf = fs.readFileSync(out); cleanup(out); }
      } else {
        // fallback: just keep original crop
      }
    }

    // composite on chosen background
    // Create background canvas
    const bgCanvas = await sharp({
      create: {
        width: 1063, height: 1417, channels: 3,
        background: bg
      }
    }).png().toBuffer();

    // Place subject over bg
    const subject = await sharp(buf).resize(1063,1417,{fit:"cover"}).png().toBuffer();
    const finalPhoto = await sharp(bgCanvas).composite([{ input: subject, left:0, top:0 }]).png().toBuffer();

    // Create A4 sheet with multiple copies (2480x3508 px @300dpi)
    const a4w=2480, a4h=3508;
    let sheet = sharp({ create: { width: a4w, height: a4h, channels: 3, background: "white" } }).png();
    const cols = 3, rows = 4;
    const gap = 40;
    const pw = 1063, ph = 1417;
    const ox = Math.floor((a4w - (cols*pw + (cols-1)*gap))/2);
    const oy = 120;

    const comps = [];
    let count = 0;
    for (let r=0; r<rows; r++) {
      for (let c=0; c<cols; c++) {
        if (count >= copies) break;
        comps.push({ input: finalPhoto, left: ox + c*(pw+gap), top: oy + r*(ph+gap) });
        count++;
      }
    }
    const sheetBuf = await sheet.composite(comps).png().toBuffer();

    // Export both single image and A4 PDF
    const singlePath = path.join(TMP, uuidv4()+".png");
    fs.writeFileSync(singlePath, finalPhoto);

    // A4 PDF via pdf-lib
    const pdf = await PDFDocument.create();
    const imgEmbed = await pdf.embedPng(sheetBuf);
    const page = pdf.addPage([a4w, a4h]);
    page.drawImage(imgEmbed, { x:0, y:0, width:a4w, height:a4h });
    const pdfBytes = await pdf.save();
    const pdfPath = path.join(TMP, uuidv4()+".pdf"); fs.writeFileSync(pdfPath, pdfBytes);

    cleanup(input);
    res.json({ single: path.basename(singlePath), sheet: path.basename(pdfPath) });
  } catch(e){ console.error(e); res.status(500).json({ error:"Passport tool failed" }); }
});

/** Download helper for files created by /api/passport */
app.get("/api/download/:name", (req, res)=>{
  const filePath = path.join(TMP, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
  res.download(filePath, req.params.name, ()=> cleanup(filePath));
});

app.listen(PORT, ()=> console.log(`✅ Server at http://localhost:${PORT}`));
