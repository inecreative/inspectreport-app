'use strict';

/**
 * Client-side PDF export.
 *
 * Builds a real downloadable PDF in the browser with jsPDF. (Do NOT use
 * window.print() here — it silently fails when the app runs in embedded
 * frames.) The PDF mirrors the on-screen preview: header, property/client
 * table including custom fields, summary, findings with severity + cost,
 * and finding photos. The filename comes from the property address.
 */

const SEVERITY_COLORS = {
  Good: [30, 123, 52],
  Monitor: [138, 109, 0],
  Repair: [192, 86, 0],
  Urgent: [179, 38, 30],
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
    const contentW = pageW - margin * 2;
    let y = 0;

    const ensureSpace = (needed) => {
      if (y + needed > pageH - margin) {
        doc.addPage();
        y = margin;
      }
    };

    /* Header band */
    doc.setFillColor(15, 42, 61);
    doc.rect(0, 0, pageW, 92, 'F');
    doc.setFillColor(217, 119, 6);
    doc.rect(0, 92, pageW, 5, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text('Home Inspection Report', margin, 42);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(207, 224, 236);
    doc.text(report.address || 'Property inspection', margin, 66);
    y = 128;

    /* Property & client table */
    const rows = [
      ['Property address', report.address || '—'],
      ['Inspection date', report.inspection_date ? String(report.inspection_date).slice(0, 10) : '—'],
      ['Client', report.client_name || '—'],
      ['Client email', report.client_email || '—'],
      ['Client phone', report.client_phone || '—'],
      ['Inspector', report.inspector_name || '—'],
      ...customFields.map((f) => [f.name || 'Field', f.value || '—']),
    ];
    doc.setFontSize(11);
    for (const [label, value] of rows) {
      const valueLines = doc.splitTextToSize(String(value), contentW - 170);
      const rowH = Math.max(20, valueLines.length * 14 + 7);
      ensureSpace(rowH);
      doc.setFillColor(238, 243, 246);
      doc.rect(margin, y - 13, 150, rowH, 'F');
      doc.setDrawColor(140, 155, 166);
      doc.rect(margin, y - 13, contentW, rowH);
      doc.line(margin + 150, y - 13, margin + 150, y - 13 + rowH);
      doc.setTextColor(15, 42, 61);
      doc.setFont('helvetica', 'bold');
      doc.text(String(label), margin + 8, y + 2);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(22, 35, 44);
      doc.text(valueLines, margin + 160, y + 2);
      y += rowH + 4;
    }
    y += 10;

    /* Summary */
    if (report.summary) {
      ensureSpace(40);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.setTextColor(15, 42, 61);
      doc.text('Executive summary', margin, y);
      y += 8;
      doc.setDrawColor(217, 119, 6);
      doc.setLineWidth(2);
      doc.line(margin, y, margin + 46, y);
      y += 18;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(22, 35, 44);
      const lines = doc.splitTextToSize(report.summary, contentW);
      for (const line of lines) {
        ensureSpace(15);
        doc.text(line, margin, y);
        y += 15;
      }
      y += 10;
    }

    /* Findings */
    ensureSpace(40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(15, 42, 61);
    doc.text(`Findings (${findings.length})`, margin, y);
    y += 8;
    doc.setDrawColor(217, 119, 6);
    doc.setLineWidth(2);
    doc.line(margin, y, margin + 46, y);
    y += 20;

    let total = 0;
    for (let i = 0; i < findings.length; i += 1) {
      const f = findings[i];
      total += Number(f.cost || 0);
      const titleLines = doc.splitTextToSize(
        `${i + 1}. ${f.area ? `${f.area} — ` : ''}${f.title || 'Finding'}`,
        contentW - 170
      );
      const detailLines = f.detail ? doc.splitTextToSize(f.detail, contentW) : [];
      ensureSpace(titleLines.length * 15 + detailLines.length * 14 + 30);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(15, 42, 61);
      doc.text(titleLines, margin, y);
      const sev = f.severity || 'Monitor';
      const color = SEVERITY_COLORS[sev] || SEVERITY_COLORS.Monitor;
      doc.setFontSize(11);
      doc.setTextColor(color[0], color[1], color[2]);
      const sevText = `${sev.toUpperCase()}  ·  ${pdfMoney(f.cost)}`;
      doc.text(sevText, margin + contentW - doc.getTextWidth(sevText), y);
      y += titleLines.length * 15 + 2;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(11);
      doc.setTextColor(22, 35, 44);
      for (const line of detailLines) {
        ensureSpace(14);
        doc.text(line, margin, y);
        y += 14;
      }
      y += 4;

      /* Finding photos */
      for (const photo of f.photos || []) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { dataUrl } = await imageToDataUrl(photo.url);
          // eslint-disable-next-line no-await-in-loop
          const size = await imageSize(dataUrl);
          const w = Math.min(300, contentW);
          const h = (w * size.h) / size.w;
          ensureSpace(h + 8);
          doc.addImage(dataUrl, undefined, margin, y, w, h);
          y += h + 10;
        } catch (_) {
          /* skip a photo that cannot be loaded */
        }
      }
      y += 8;
    }

    /* Total */
    ensureSpace(30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(15, 42, 61);
    const totalText = `Total estimated repair cost: ${pdfMoney(total)}`;
    doc.text(totalText, margin + contentW - doc.getTextWidth(totalText), y + 6);

    doc.save(pdfFilename(report.address));
    setStatus('✓ PDF downloaded');
    setTimeout(() => setStatus(''), 5000);
  } catch (err) {
    console.error(err);
    setStatus('PDF failed — please try again.');
  }
}

window.downloadReportPdf = downloadReportPdf;
