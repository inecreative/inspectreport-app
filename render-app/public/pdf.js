'use strict';

/**
 * Client-side PDF export.
 *
 * Builds a real downloadable PDF in the browser with jsPDF. (Do NOT use
 * window.print() here — it silently fails when the app runs in embedded
 * frames.)
 *
 * The PDF is a 1:1 port of the on-screen preview document (app.js
 * renderPreview + the .report styles in styles.css): navy header block
 * with the amber "HOME INSPECTION REPORT" badge and the address as the
 * title, the two-column Client/Date/Inspector meta grid, the cream
 * executive-summary box, findings with inline severity + cost pills,
 * thumbnail photo rows, the total row with signature line, and the
 * disclaimer. Keep this file in sync with the preview markup/styles —
 * the founder's rule is that the download must look like the preview.
 */

const SEV_PDF = {
  Good: { bg: [220, 252, 231], fg: [21, 128, 61] },
  Monitor: { bg: [254, 249, 195], fg: [161, 98, 7] },
  Repair: { bg: [255, 237, 213], fg: [194, 65, 12] },
  Urgent: { bg: [254, 226, 226], fg: [185, 28, 28] },
};
const C = {
  navy: [15, 42, 61],
  ink: [17, 24, 39],
  badgeAmber: [245, 158, 11],
  headSub: [219, 223, 226],
  metaLabel: [107, 114, 128],
  line: [229, 231, 235],
  itemLine: [243, 244, 246],
  costBg: [243, 244, 246],
  sumBg: [255, 251, 235],
  sumBorder: [253, 230, 138],
  disclaimer: [156, 163, 175],
};

function pdfMoney(n) {
  return `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function pdfFilename(address) {
  const base = String(address || 'inspection-report')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${base || 'inspection-report'}-inspection-report.pdf`;
}

async function imageToDataUrl(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`photo fetch ${res.status}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataUrl: reader.result, type: blob.type });
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function imageSize(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 4, h: 3 });
    img.src = dataUrl;
  });
}

/**
 * Cover-crop an image to the target aspect (like CSS object-fit: cover),
 * so PDF photos are never stretched. Returns a JPEG data URL rendered at
 * 2x the target point size. Falls back to the original image on failure.
 */
function coverCroppedDataUrl(dataUrl, targetW, targetH) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const ratio = targetW / targetH;
        const srcRatio = img.naturalWidth / img.naturalHeight;
        let sw;
        let sh;
        let sx;
        let sy;
        if (srcRatio > ratio) {
          sh = img.naturalHeight;
          sw = sh * ratio;
          sx = (img.naturalWidth - sw) / 2;
          sy = 0;
        } else {
          sw = img.naturalWidth;
          sh = sw / ratio;
          sx = 0;
          sy = (img.naturalHeight - sh) / 2;
        }
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(targetW * 2);
        canvas.height = Math.round(targetH * 2);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.88));
      } catch (_) {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

/**
 * @param {object} data — full report payload { report, customFields, findings }
 * @param {(msg: string) => void} setStatus — status text near the button
 */
async function downloadReportPdf(data, setStatus) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    setStatus('PDF library failed to load — check your connection and try again.');
    return;
  }
  const { report, customFields, findings } = data;
  setStatus('Building PDF…');
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 48;
    const contentW = pageW - margin * 2; // header block spans this width
    const bodyX = margin + 18; // body content is inset, like the preview card
    const bodyW = contentW - 36;
    const topY = 44;
    const bottomY = pageH - 46;
    let y = topY;

    const ensureSpace = (needed) => {
      if (y + needed > bottomY) {
        doc.addPage();
        y = topY;
      }
    };
    const setColor = (rgb) => doc.setTextColor(rgb[0], rgb[1], rgb[2]);
    const fillColor = (rgb) => doc.setFillColor(rgb[0], rgb[1], rgb[2]);

    /* ---------- House photo (report cover, top of the document) ---------- */
    if (report.cover_url) {
      try {
        const { dataUrl } = await imageToDataUrl(report.cover_url);
        const cover = await coverCroppedDataUrl(dataUrl, contentW, 138);
        doc.addImage(cover, 'JPEG', margin, y, contentW, 138);
        y += 138 + 16;
      } catch (_) {
        /* skip a cover that cannot be loaded */
      }
    }

    /* ---------- Header block (navy card head) ---------- */
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19.5);
    const addrLines = doc.splitTextToSize(
      report.address || 'Add a property address to start your report',
      bodyW
    );
    const headH = 13 + 17 + 9 + addrLines.length * 23 + 7 + 13 + 15;
    fillColor(C.navy);
    doc.roundedRect(margin, y, contentW, headH, 7, 7, 'F');
    // Amber badge
    const badgeText = 'HOME INSPECTION REPORT';
    doc.setFontSize(8.5);
    doc.setCharSpace(0.5);
    const badgeW = doc.getTextWidth(badgeText) + 18;
    fillColor(C.badgeAmber);
    doc.roundedRect(bodyX, y + 13, badgeW, 17, 4, 4, 'F');
    doc.setTextColor(17, 24, 39);
    doc.text(badgeText, bodyX + badgeW / 2, y + 13 + 12, { align: 'center' });
    doc.setCharSpace(0);
    // Address title
    doc.setFontSize(19.5);
    setColor([255, 255, 255]);
    let ty = y + 13 + 17 + 9 + 17;
    for (const line of addrLines) {
      doc.text(line, bodyX, ty);
      ty += 23;
    }
    // Subline
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    setColor(C.headSub);
    doc.text('Professional inspection report · Generated with InspectReport AI', bodyX, ty + 2);
    y += headH + 20;

    /* ---------- Meta grid (2 columns, like the preview) ---------- */
    const rows = [
      ['Client', report.client_name || '—'],
      ['Date', report.inspection_date ? String(report.inspection_date).slice(0, 10) : '—'],
      ['Inspector', report.inspector_name || '—'],
      ['Client email', report.client_email || '—'],
      ['Client phone', report.client_phone || '—'],
      ...customFields.map((f) => [f.name || 'Field', f.value || '—']),
    ];
    const colGap = 14;
    const colW = (bodyW - colGap) / 2;
    for (let i = 0; i < rows.length; i += 2) {
      const cells = rows.slice(i, i + 2).map(([label, value]) => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        const valueLines = doc.splitTextToSize(String(value), colW);
        return { label, valueLines, h: 11 + valueLines.length * 13.5 };
      });
      const rowH = Math.max(...cells.map((c) => c.h));
      ensureSpace(rowH + 10);
      cells.forEach((cell, j) => {
        const cx = bodyX + j * (colW + colGap);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setCharSpace(0.9);
        setColor(C.metaLabel);
        doc.text(String(cell.label).toUpperCase(), cx, y + 8);
        doc.setCharSpace(0);
        doc.setFontSize(11);
        setColor(C.ink);
        let vy = y + 8 + 14;
        for (const line of cell.valueLines) {
          doc.text(line, cx, vy);
          vy += 13.5;
        }
      });
      y += rowH + 10;
    }
    doc.setDrawColor(C.line[0], C.line[1], C.line[2]);
    doc.setLineWidth(1.1);
    doc.line(bodyX, y - 2, bodyX + bodyW, y - 2);
    y += 14;

    /* ---------- Section heading helper ---------- */
    const heading = (text) => {
      ensureSpace(30);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11.5);
      doc.setCharSpace(1);
      setColor(C.navy);
      doc.text(text, bodyX, y + 11);
      doc.setCharSpace(0);
      y += 26;
    };

    /* ---------- Executive summary (cream box) ---------- */
    if (report.summary) {
      heading('EXECUTIVE SUMMARY');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.8);
      const lines = doc.splitTextToSize(report.summary, bodyW - 24);
      const boxH = lines.length * 15.8 + 22;
      ensureSpace(boxH);
      fillColor(C.sumBg);
      doc.setDrawColor(C.sumBorder[0], C.sumBorder[1], C.sumBorder[2]);
      doc.setLineWidth(1.2);
      doc.roundedRect(bodyX, y, bodyW, boxH, 6, 6, 'FD');
      setColor(C.ink);
      let sy = y + 11 + 11;
      for (const line of lines) {
        doc.text(line, bodyX + 12, sy);
        sy += 15.8;
      }
      y += boxH + 4;
    }

    /* ---------- Findings ---------- */
    heading(`FINDINGS (${findings.length})`);
    const drawPill = (x, pillTop, text, bg, fg) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.3);
      const w = doc.getTextWidth(text) + 15;
      fillColor(bg);
      doc.roundedRect(x, pillTop, w, 15, 4, 4, 'F');
      setColor(fg);
      doc.text(text, x + w / 2, pillTop + 10.8, { align: 'center' });
      return w;
    };

    let total = 0;
    if (!findings.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      setColor(C.metaLabel);
      doc.text(
        'No findings yet — your documented items will be grouped by area here, with photos.',
        bodyX,
        y + 11
      );
      y += 24;
    }
    for (let i = 0; i < findings.length; i += 1) {
      const f = findings[i];
      total += Number(f.cost || 0);
      const sev = SEV_PDF[f.severity] ? f.severity : 'Monitor';
      const sevColors = SEV_PDF[sev];
      const title = `${i + 1}. ${f.area ? `${f.area} — ` : ''}${f.title || 'Finding'}`;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11.5);
      const titleLines = doc.splitTextToSize(title, bodyW);
      const firstLineW = doc.getTextWidth(titleLines[0]);
      // Pill widths (severity always; cost only when set, like the preview)
      doc.setFontSize(8.3);
      const sevW = doc.getTextWidth(sev) + 15;
      const costText = f.cost ? `~${pdfMoney(f.cost)}` : null;
      const costW = costText ? doc.getTextWidth(costText) + 15 : 0;
      const pillsW = sevW + (costText ? 5 + costW : 0);
      const pillsInline = firstLineW + 7 + pillsW <= bodyW;
      ensureSpace(titleLines.length * 15 + (pillsInline ? 0 : 19) + 20);
      // Title
      doc.setFontSize(11.5);
      setColor(C.ink);
      let ly = y + 11.5;
      for (const line of titleLines) {
        doc.text(line, bodyX, ly);
        ly += 15;
      }
      // Pills
      const pillTop = pillsInline ? y + 1 : ly - 15 + 5;
      let px = pillsInline ? bodyX + firstLineW + 7 : bodyX;
      px += drawPill(px, pillTop, sev, sevColors.bg, sevColors.fg) + 5;
      if (costText) drawPill(px, pillTop, costText, C.costBg, C.ink);
      y += titleLines.length * 15 + (pillsInline ? 2 : 21);

      // Detail
      if (f.detail) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10.6);
        setColor(C.ink);
        const detailLines = doc.splitTextToSize(f.detail, bodyW);
        y += 3;
        for (const line of detailLines) {
          ensureSpace(15.5);
          doc.text(line, bodyX, y + 10.6);
          y += 15.5;
        }
        y += 2;
      }

      // Photos — thumbnail row like the preview (72×54 pt, wrap)
      const photos = f.photos || [];
      if (photos.length) {
        const tw = 72;
        const th = 54;
        const gap = 6;
        const perRow = Math.max(1, Math.floor((bodyW + gap) / (tw + gap)));
        y += 5;
        for (let p = 0; p < photos.length; p += perRow) {
          ensureSpace(th + 6);
          const rowPhotos = photos.slice(p, p + perRow);
          for (let q = 0; q < rowPhotos.length; q += 1) {
            try {
              // eslint-disable-next-line no-await-in-loop
              const { dataUrl } = await imageToDataUrl(rowPhotos[q].url);
              // eslint-disable-next-line no-await-in-loop
              const cropped = await coverCroppedDataUrl(dataUrl, tw, th);
              doc.addImage(cropped, 'JPEG', bodyX + q * (tw + gap), y, tw, th);
            } catch (_) {
              /* skip a photo that cannot be loaded */
            }
          }
          y += th + 6;
        }
      }

      // Item separator (preview draws one under every item but the last)
      if (i < findings.length - 1) {
        y += 5;
        ensureSpace(16);
        doc.setDrawColor(C.itemLine[0], C.itemLine[1], C.itemLine[2]);
        doc.setLineWidth(0.8);
        doc.line(bodyX, y, bodyX + bodyW, y);
        y += 13;
      } else {
        y += 6;
      }
    }

    /* ---------- Total row + signature ---------- */
    ensureSpace(64);
    y += 8;
    doc.setDrawColor(C.line[0], C.line[1], C.line[2]);
    doc.setLineWidth(1.1);
    doc.line(bodyX, y, bodyX + bodyW, y);
    y += 19;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    setColor(C.metaLabel);
    doc.text('Total estimated repairs: ', bodyX, y);
    const labelW = doc.getTextWidth('Total estimated repairs: ');
    doc.setFont('helvetica', 'bold');
    setColor(C.ink);
    doc.text(pdfMoney(total), bodyX + labelW, y);
    doc.setFont('helvetica', 'normal');
    setColor(C.metaLabel);
    const sigText = 'Inspector signature: ___________________';
    doc.text(sigText, bodyX + bodyW - doc.getTextWidth(sigText), y);
    y += 12;

    /* ---------- Disclaimer ---------- */
    doc.setFontSize(8.3);
    setColor(C.disclaimer);
    const disclaimer =
      'This report summarizes visible conditions at the time of inspection. It is not a warranty or guarantee. Costs are ballpark estimates for planning only — obtain licensed contractor quotes for exact pricing. Photos are inspector-provided.';
    for (const line of doc.splitTextToSize(disclaimer, bodyW)) {
      ensureSpace(11.5);
      doc.text(line, bodyX, y + 8.3);
      y += 11.5;
    }

    doc.save(pdfFilename(report.address));
    setStatus('✓ PDF downloaded');
    setTimeout(() => setStatus(''), 5000);
  } catch (err) {
    console.error(err);
    setStatus('PDF failed — please try again.');
  }
}

window.downloadReportPdf = downloadReportPdf;
