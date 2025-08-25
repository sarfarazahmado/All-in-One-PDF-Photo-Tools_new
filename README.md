
# YourPDF Pro — All-in-One (MVP)

Run locally in VS Code.

## Features
- Merge, Split, Compress
- Unlock (with password)
- Images -> PDF
- Office (DOC/DOCX/PPT/XLS) -> PDF  (LibreOffice required)
- PDF -> DOCX
  - Fast (LibreOffice, no OCR)
  - OCR mode (needs Ghostscript + Tesseract)
- Annotate (text + highlights)
- Sign (overlay image)
- Passport Size Photo (3.5x4.5cm @300dpi, bg removal via `rembg` if installed, color options; A4 sheet output)

## Requirements
- Node.js 18+
- Optional CLI:
  - **LibreOffice** (office conversions + fast pdf->docx)
  - **Ghostscript** (`gs`) for compress + OCR rasterization
  - **Tesseract OCR** (`tesseract`) for OCR mode
  - **rembg** CLI for background removal (pip install rembg)

## Install & Run
```bash
npm install
node server.js
# open http://localhost:3000
```

## Notes
- Files are saved in `tmp/` then auto-deleted on download.
- Annotate JSON example:
```json
[
  {"type":"text","page":1,"x":80,"y":700,"size":14,"value":"Hello"},
  {"type":"highlight","page":1,"x":70,"y":680,"w":180,"h":20}
]
```
- Sign tool: select **two files** (first your PDF, second your signature PNG).
- Passport tool outputs: single PNG and an A4 PDF sheet with multiple copies.
