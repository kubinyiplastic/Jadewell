// Közös PDF segédmodul: ékezetes fontok + JadeWell logó + fejléc/lábléc
const path = require('path');
const fs = require('fs');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const REGULAR_FONT = path.join(ASSETS_DIR, 'DejaVuSans.ttf');
const BOLD_FONT = path.join(ASSETS_DIR, 'DejaVuSans-Bold.ttf');
const LOGO_SVG = path.join(ASSETS_DIR, 'logo.svg');

// SVG path-ok kinyerése a logo.svg-ből (cache-elve)
let LOGO_PATHS = null;
function getLogoPaths() {
  if (LOGO_PATHS !== null) return LOGO_PATHS;
  try {
    if (!fs.existsSync(LOGO_SVG)) {
      LOGO_PATHS = [];
      return LOGO_PATHS;
    }
    const content = fs.readFileSync(LOGO_SVG, 'utf-8');
    const regex = /<path d="([^"]+)" fill="([^"]+)"/g;
    LOGO_PATHS = [];
    let m;
    while ((m = regex.exec(content)) !== null) {
      LOGO_PATHS.push({ d: m[1], fill: m[2] });
    }
  } catch (e) {
    console.error('Logo betöltési hiba:', e.message);
    LOGO_PATHS = [];
  }
  return LOGO_PATHS;
}

/**
 * Magyar ékezetes fontok regisztrálása. Hívd meg minden új PDFDocument-nél.
 * Utána a 'Sans' és 'SansBold' fontnevek használhatók doc.font(...) hívással.
 */
function registerFonts(doc) {
  try {
    if (fs.existsSync(REGULAR_FONT)) {
      doc.registerFont('Sans', REGULAR_FONT);
    }
    if (fs.existsSync(BOLD_FONT)) {
      doc.registerFont('SansBold', BOLD_FONT);
    }
    if (fs.existsSync(REGULAR_FONT)) {
      doc.font('Sans');
    }
  } catch (e) {
    console.error('Font regisztrációs hiba:', e.message);
  }
}

/**
 * JadeWell logó vektorosan a PDF-be (SVG path-ok közvetlen rajzolása).
 * Az SVG eredeti tartomány: x=265..770, y=480..580 (1080x1080 viewbox-on belül).
 */
function drawLogo(doc, x, y, targetWidth = 130) {
  const paths = getLogoPaths();
  if (paths.length === 0) {
    // Fallback: csak szöveg
    doc.font('SansBold').fontSize(22).fillColor('#1a4d4a').text('JadeWell', x, y);
    return;
  }

  const svgWidth = 505;  // path-ok befoglaló szélessége
  const svgOffsetX = 265; // path-ok bal széle
  const svgOffsetY = 480; // path-ok felső széle
  const scale = targetWidth / svgWidth;

  doc.save();
  doc.translate(x - svgOffsetX * scale, y - svgOffsetY * scale);
  doc.scale(scale);

  paths.forEach(p => {
    doc.path(p.d).fill(p.fill);
  });

  doc.restore();
}

/**
 * Standard JadeWell PDF fejléc.
 * @returns {number} A fejléc alatti y koordináta (innentől jöhet a tartalom)
 */
function drawHeader(doc, options = {}) {
  const { rightTitle, rightSubtitle } = options;

  // Logó bal oldalt
  drawLogo(doc, 50, 40, 130);

  // Kontakt info a logó alatt
  doc.font('Sans').fontSize(8).fillColor('#666')
    .text('Medence és szauna kivitelezés', 50, 95)
    .text('4243 Téglás, Akácos utca 2/B', 50, 107)
    .text('+36 20 240 6463 · info@jadewell.hu · jadewell.hu', 50, 119);

  // Jobb oldali cím
  if (rightTitle) {
    doc.font('SansBold').fontSize(20).fillColor('#1a4d4a')
      .text(rightTitle, 350, 45, { width: 195, align: 'right' });
  }
  if (rightSubtitle) {
    doc.font('Sans').fontSize(10).fillColor('#333')
      .text(rightSubtitle, 350, 72, { width: 195, align: 'right' });
  }

  // Vízszintes elválasztó vonal
  doc.moveTo(50, 138).lineTo(545, 138).strokeColor('#1a4d4a').lineWidth(2).stroke();

  return 158; // tartalom innen kezdődhet
}

/**
 * Standard lábléc - alkalmazza minden oldalra.
 */
function drawFooter(doc) {
  const pageHeight = doc.page.height;
  const y = pageHeight - 50;
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#e5e5e5').lineWidth(0.5).stroke();
  doc.font('Sans').fontSize(8).fillColor('#999')
    .text('JadeWell · 4243 Téglás, Akácos utca 2/B · +36 20 240 6463 · info@jadewell.hu',
      50, y + 8, { align: 'center', width: 495 });
}

module.exports = {
  registerFonts,
  drawLogo,
  drawHeader,
  drawFooter,
  REGULAR_FONT,
  BOLD_FONT
};
