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
 * company footer. Keep this file in sync with the preview markup/styles —
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

/* --- Estimate helpers: exact duplicates of the math in app.js
   (estimateTotals / lineTotal / estimateSections / estimateValidUntil)
   so the printed estimate always matches the preview. --- */
function pdfMoneyC(n) {
  return `$${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pdfRound2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function pdfLineTotal(it) {
  return pdfRound2(Number(it.qty || 0) * Number(it.unit_price || 0));
}

function pdfEstimateTotals(items, report) {
  const list = items || [];
  const subtotal = pdfRound2(
    list.filter((i) => !i.optional).reduce((s, i) => s + pdfLineTotal(i), 0)
  );
  const optionalSubtotal = pdfRound2(
    list.filter((i) => i.optional).reduce((s, i) => s + pdfLineTotal(i), 0)
  );
  const dv = Number(report.discount_value || 0);
  const discount = pdfRound2(
    report.discount_type === 'amt' ? Math.min(dv, subtotal) : (subtotal * dv) / 100
  );
  const taxable = pdfRound2(subtotal - discount);
  const taxRate = Number(report.tax_rate || 0);
  const tax = pdfRound2((taxable * taxRate) / 100);
  const total = pdfRound2(taxable + tax);
  const depositPct = Number(report.deposit_pct || 0);
  const deposit = pdfRound2((total * depositPct) / 100);
  return { subtotal, optionalSubtotal, discount, taxable, taxRate, tax, total, depositPct, deposit };
}

const PDF_KIND_LABEL = { labor: 'Labor', material: 'Material', item: 'Item' };

function pdfEstimateSections(items) {
  const order = [];
  const map = new Map();
  for (const it of items || []) {
    const name = it.section || '';
    if (!map.has(name)) {
      map.set(name, []);
      order.push(name);
    }
    map.get(name).push(it);
  }
  return order.map((name) => ({ name, items: map.get(name) }));
}

function pdfValidUntil(report) {
  const days = Number(report.valid_days || 0);
  if (!days) return null;
  const base = report.inspection_date
    ? new Date(`${String(report.inspection_date).slice(0, 10)}T12:00:00`)
    : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString().slice(0, 10);
}

function pdfFilename(address, isJob, isEstimate) {
  const kind = isEstimate ? 'estimate' : isJob ? 'job-report' : 'inspection-report';
  const base = String(address || kind)
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${base || kind}-${kind}.pdf`;
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
  if (data && data.report && data.report.doc_type === 'estimate') {
    await downloadEstimatePdf(data, setStatus);
    return;
  }
  const { report, customFields, findings, profile } = data;
  const isJob = report.doc_type === 'job';
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
    // The cover and the navy header form ONE flush unit, exactly like the
    // preview card: no gap between them, and when a cover is present the
    // header block is a plain rectangle (square top corners) so the two
    // blocks meet seamlessly.
    let hasCover = false;
    if (report.cover_url) {
      try {
        const { dataUrl } = await imageToDataUrl(report.cover_url);
        const cover = await coverCroppedDataUrl(dataUrl, contentW, 138);
        doc.addImage(cover, 'JPEG', margin, y, contentW, 138);
        y += 138;
        hasCover = true;
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
    const headH = 13 + 17 + 9 + addrLines.length * 23 + 15;
    fillColor(C.navy);
    if (hasCover) {
      doc.rect(margin, y, contentW, headH, 'F');
    } else {
      doc.roundedRect(margin, y, contentW, headH, 7, 7, 'F');
    }
    // Amber badge. NOTE: jsPDF's getTextWidth does NOT include the
    // per-character spacing set via setCharSpace, so add it manually —
    // otherwise the badge box comes out too narrow and the end of the
    // text spills off the amber onto the navy.
    const badgeText = isJob ? 'JOB REPORT' : 'HOME INSPECTION REPORT';
    const badgeCharSpace = 0.5;
    doc.setFontSize(8.5);
    doc.setCharSpace(badgeCharSpace);
    const badgeW = doc.getTextWidth(badgeText) + badgeText.length * badgeCharSpace + 22;
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
    y += headH + 20;

    /* ---------- Meta grid (2 columns, like the preview) ---------- */
    const rows = [
      ['Client', report.client_name || '—'],
      ['Date', report.inspection_date ? String(report.inspection_date).slice(0, 10) : '—'],
      [isJob ? 'Prepared by' : 'Inspector', report.inspector_name || '—'],
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
      // Clear section break between the summary and Findings: a rule
      // across the body width, slightly stronger than the meta divider,
      // so the two sections read as unmistakably separate blocks.
      ensureSpace(58);
      y += 8;
      doc.setDrawColor(196, 201, 209);
      doc.setLineWidth(1.4);
      doc.line(bodyX, y, bodyX + bodyW, y);
      y += 6;
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

      // Photos — thumbnail row like the preview, at 144×108 pt (wrap)
      const photos = f.photos || [];
      if (photos.length) {
        const tw = 144;
        const th = 108;
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
    const sigText = `${isJob ? 'Signature' : 'Inspector signature'}: ___________________`;
    doc.text(sigText, bodyX + bodyW - doc.getTextWidth(sigText), y);
    y += 12;

    /* ---------- Company footer (replaces the old disclaimer) ---------- */
    const coName =
      (profile && profile.companyName) || report.inspector_name || (profile && profile.fullName) || '';
    const coLine = [
      profile && profile.companyAddress,
      profile && profile.phone,
      profile && profile.email,
    ]
      .filter((v) => v && String(v).trim())
      .join(' · ');
    if (coName) {
      ensureSpace(16);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      setColor(C.ink);
      doc.text(coName, bodyX, y + 10.5);
      y += 15;
    }
    if (coLine) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      setColor(C.disclaimer);
      for (const line of doc.splitTextToSize(coLine, bodyW)) {
        ensureSpace(12);
        doc.text(line, bodyX, y + 9);
        y += 12;
      }
    }

    doc.save(pdfFilename(report.address, isJob));
    setStatus('✓ PDF downloaded');
    setTimeout(() => setStatus(''), 5000);
  } catch (err) {
    console.error(err);
    setStatus('PDF failed — please try again.');
  }
}

/**
 * Estimate PDF — a 1:1 port of app.js renderEstimatePreview: navy
 * header with the amber ESTIMATE badge, meta grid (incl. estimate
 * number + valid-until), line items grouped by section with amounts,
 * the optional block (excluded from the total), the totals box,
 * scope / exclusions / terms, the deposit line, approval signature
 * lines, and the company footer.
 */
async function downloadEstimatePdf(data, setStatus) {
  const { report, customFields, estimateItems, profile } = data;
  const items = estimateItems || [];
  setStatus('Building PDF…');
  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 48;
    const contentW = pageW - margin * 2;
    const bodyX = margin + 18;
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

    /* ---------- House photo (report cover) ---------- */
    let hasCover = false;
    if (report.cover_url) {
      try {
        const { dataUrl } = await imageToDataUrl(report.cover_url);
        const cover = await coverCroppedDataUrl(dataUrl, contentW, 138);
        doc.addImage(cover, 'JPEG', margin, y, contentW, 138);
        y += 138;
        hasCover = true;
      } catch (_) {
        /* skip a cover that cannot be loaded */
      }
    }

    /* ---------- Header block ---------- */
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19.5);
    const addrLines = doc.splitTextToSize(
      report.address || 'Add a property address to start your estimate',
      bodyW
    );
    const headH = 13 + 17 + 9 + addrLines.length * 23 + 15;
    fillColor(C.navy);
    if (hasCover) {
      doc.rect(margin, y, contentW, headH, 'F');
    } else {
      doc.roundedRect(margin, y, contentW, headH, 7, 7, 'F');
    }
    const badgeText = 'ESTIMATE';
    const badgeCharSpace = 0.5;
    doc.setFontSize(8.5);
    doc.setCharSpace(badgeCharSpace);
    const badgeW = doc.getTextWidth(badgeText) + badgeText.length * badgeCharSpace + 22;
    fillColor(C.badgeAmber);
    doc.roundedRect(bodyX, y + 13, badgeW, 17, 4, 4, 'F');
    doc.setTextColor(17, 24, 39);
    doc.text(badgeText, bodyX + badgeW / 2, y + 13 + 12, { align: 'center' });
    doc.setCharSpace(0);
    doc.setFontSize(19.5);
    setColor([255, 255, 255]);
    let ty = y + 13 + 17 + 9 + 17;
    for (const line of addrLines) {
      doc.text(line, bodyX, ty);
      ty += 23;
    }
    y += headH + 20;

    /* ---------- Meta grid ---------- */
    const validUntil = pdfValidUntil(report);
    const rows = [
      ['Client', report.client_name || '—'],
      ['Date', report.inspection_date ? String(report.inspection_date).slice(0, 10) : '—'],
      ['Prepared by', report.inspector_name || '—'],
      ['Client email', report.client_email || '—'],
      ['Client phone', report.client_phone || '—'],
      ...(report.estimate_number ? [['Estimate #', report.estimate_number]] : []),
      ...(validUntil ? [['Valid until', validUntil]] : []),
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

    /* ---------- Line items ---------- */
    const t = pdfEstimateTotals(items, report);
    const drawItem = (it) => {
      const amt = pdfMoneyC(pdfLineTotal(it));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      const amtW = doc.getTextWidth(amt);
      doc.setFontSize(11.5);
      const descLines = doc.splitTextToSize(it.description || 'Line item', bodyW - amtW - 12);
      ensureSpace(descLines.length * 15 + 22);
      setColor(C.ink);
      let ly = y + 11.5;
      descLines.forEach((line, li) => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11.5);
        doc.text(line, bodyX, ly);
        if (li === 0) {
          doc.setFontSize(10.5);
          doc.text(amt, bodyX + bodyW - amtW, ly);
        }
        ly += 15;
      });
      y += descLines.length * 15;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.6);
      setColor(C.ink);
      const sub = `${PDF_KIND_LABEL[it.kind] || 'Item'} · ${Number(it.qty || 0)}${it.unit ? ` ${it.unit}` : ''} × ${pdfMoneyC(it.unit_price)}`;
      ensureSpace(15.5);
      doc.text(sub, bodyX, y + 10.6);
      y += 17.5;
    };
    const drawSeparator = () => {
      y += 4;
      ensureSpace(16);
      doc.setDrawColor(C.itemLine[0], C.itemLine[1], C.itemLine[2]);
      doc.setLineWidth(0.8);
      doc.line(bodyX, y, bodyX + bodyW, y);
      y += 12;
    };

    const sections = pdfEstimateSections(items);
    const billableSections = sections
      .map((sec) => ({ name: sec.name, items: sec.items.filter((i) => !i.optional) }))
      .filter((sec) => sec.items.length);
    const optionalItems = items.filter((i) => i.optional);

    if (!billableSections.length && !optionalItems.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      setColor(C.metaLabel);
      doc.text(
        'No line items yet — add sections and items on the left, and they will appear here grouped by section.',
        bodyX,
        y + 11
      );
      y += 24;
    }
    billableSections.forEach((sec) => {
      if (sec.name) heading(sec.name.toUpperCase());
      sec.items.forEach((it, idx) => {
        drawItem(it);
        if (idx < sec.items.length - 1) drawSeparator();
      });
      y += 4;
    });
    if (optionalItems.length) {
      heading('OPTIONAL — NOT INCLUDED IN TOTAL');
      optionalItems.forEach((it, idx) => {
        drawItem(it);
        if (idx < optionalItems.length - 1) drawSeparator();
      });
      y += 2;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.8);
      setColor(C.ink);
      doc.text('Optional subtotal: ', bodyX, y + 10.8);
      const lblW = doc.getTextWidth('Optional subtotal: ');
      doc.setFont('helvetica', 'bold');
      doc.text(pdfMoneyC(t.optionalSubtotal), bodyX + lblW, y + 10.8);
      y += 20;
    }

    /* ---------- Totals box ---------- */
    ensureSpace(110);
    y += 8;
    doc.setDrawColor(C.line[0], C.line[1], C.line[2]);
    doc.setLineWidth(1.1);
    doc.line(bodyX, y, bodyX + bodyW, y);
    y += 8;
    const totalRow = (label, value, grand) => {
      ensureSpace(grand ? 26 : 20);
      y += grand ? 17 : 14;
      doc.setFont('helvetica', grand ? 'bold' : 'normal');
      doc.setFontSize(grand ? 13.5 : 10.8);
      setColor(C.ink);
      doc.text(label, bodyX, y);
      doc.setFont('helvetica', 'bold');
      const vw = doc.getTextWidth(value);
      doc.text(value, bodyX + bodyW - vw, y);
      y += 7;
    };
    totalRow('Subtotal', pdfMoneyC(t.subtotal), false);
    if (t.discount) totalRow('Discount', `−${pdfMoneyC(t.discount)}`, false);
    if (t.tax) totalRow(`Tax (${t.taxRate}%)`, pdfMoneyC(t.tax), false);
    totalRow('Total', pdfMoneyC(t.total), true);
    if (t.deposit) {
      totalRow(`Deposit due to schedule (${t.depositPct}%)`, pdfMoneyC(t.deposit), false);
    }
    y += 6;

    /* ---------- Scope / Exclusions / Terms ---------- */
    const textSection = (title, text) => {
      if (!text || !String(text).trim()) return;
      heading(title);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.8);
      setColor(C.ink);
      for (const para of String(text).split('\n')) {
        if (!para.trim()) {
          y += 8;
          continue;
        }
        for (const line of doc.splitTextToSize(para, bodyW)) {
          ensureSpace(15.8);
          doc.text(line, bodyX, y + 10.8);
          y += 15.8;
        }
      }
      y += 6;
    };
    textSection('SCOPE OF WORK', report.scope_text);
    textSection('EXCLUSIONS', report.exclusions_text);
    textSection('TERMS', report.terms_text);

    /* ---------- Approval signature lines ---------- */
    ensureSpace(64);
    y += 8;
    doc.setDrawColor(C.line[0], C.line[1], C.line[2]);
    doc.setLineWidth(1.1);
    doc.line(bodyX, y, bodyX + bodyW, y);
    y += 19;
    if (report.approved_name) {
      // Approved online via the share link (Phase 1b): one line, same
      // spot the signature lines occupy in the preview.
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      setColor(C.ink);
      doc.text(
        `Approved: ${report.approved_name}, ${String(report.approved_at || '').slice(0, 10)}`,
        bodyX,
        y
      );
    } else {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      setColor(C.metaLabel);
      doc.text('Customer approval: ___________________', bodyX, y);
      const dateText = 'Date: ____________';
      doc.text(dateText, bodyX + bodyW - doc.getTextWidth(dateText), y);
    }
    y += 12;

    /* ---------- Company footer ---------- */
    const coName =
      (profile && profile.companyName) || report.inspector_name || (profile && profile.fullName) || '';
    const coLine = [
      profile && profile.companyAddress,
      profile && profile.phone,
      profile && profile.email,
    ]
      .filter((v) => v && String(v).trim())
      .join(' · ');
    if (coName) {
      ensureSpace(16);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      setColor(C.ink);
      doc.text(coName, bodyX, y + 10.5);
      y += 15;
    }
    if (coLine) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      setColor(C.disclaimer);
      for (const line of doc.splitTextToSize(coLine, bodyW)) {
        ensureSpace(12);
        doc.text(line, bodyX, y + 9);
        y += 12;
      }
    }

    doc.save(pdfFilename(report.address, false, true));
    setStatus('✓ PDF downloaded');
    setTimeout(() => setStatus(''), 5000);
  } catch (err) {
    console.error(err);
    setStatus('PDF failed — please try again.');
  }
}

window.downloadReportPdf = downloadReportPdf;
