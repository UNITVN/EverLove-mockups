/*
 * Figma-ready SVG export
 *
 * Walks .device and emits real SVG primitives (rect, text, image, nested
 * <svg>, linearGradient, clipPath). Result is copied to the clipboard as
 * plain text — Figma's onPaste handler detects an SVG string and converts
 * it to editable vector layers (text stays text, shapes stay shapes).
 *
 * Coverage:
 *   - solid fills, linear gradients, borders, border-radius, opacity
 *   - text (multi-line via Range.getClientRects per line)
 *   - inline <svg> icons (embedded as nested <svg>, color inherited)
 *   - <img> and `background-image: url()` — bytes are embedded as data: URIs
 *     (Figma can't load file:// or localhost URLs on paste), rounded corners
 *     and object-fit are kept. Source of bytes, in order: fetch() (works on
 *     http(s)), then `.design/figma-images.js` written by
 *     scripts/embed_figma_images.py (needed on file://, where a page can't
 *     read its own images). Anything still unreadable becomes a grey
 *     placeholder and the toast says so.
 *   - outer box-shadow (becomes native Figma drop-shadow effects)
 *   - CSS mask icons (Iconify SVG used as `mask` with `background-color` tint)
 *   - overflow clipping via <clipPath>
 * Not exported:
 *   - inset box-shadow, shadow spread, text-shadow, backdrop-filter (glass),
 *     CSS filters, rotate/skew transforms, radial gradients
 *   - pseudo-elements (::before/::after)
 *
 * Delivery: Clipboard API, then execCommand('copy'), then a downloaded .svg
 * (drag it onto the Figma canvas) — so the button never ends in a dead end.
 * `window.__figmaSvg` holds the last export for scripted use.
 *
 * Loaded by every mockup the make-mobile-design skill scaffolds. Lives in
 * skills/make-mobile-design/assets/figma-export.js; the scaffold copies it
 * into the project's .design/ folder.
 */
(function () {
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var defs = [];
  var defCounter = 0;
  var imageData = {};      // resolved src -> data: URI (or null if unreadable)
  var unreadable = [];     // srcs that could not be embedded this run
  // Where this script lives, so we can find the sibling figma-images.js and
  // key embedded images by their path relative to the project root.
  var designDir = (document.currentScript && document.currentScript.src || '').replace(/[^\/]*$/, '');
  var projectRoot = designDir.replace(/\.design\/$/, '');

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function parseRgb(str) {
    if (!str) return null;
    if (str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return { r: 0, g: 0, b: 0, a: 0 };
    var m = str.match(/rgba?\(([^)]+)\)/);
    if (m) {
      var p = m[1].split(',').map(function (s) { return parseFloat(s.trim()); });
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    // Modern color() form — Chrome resolves color-mix() to this.
    // e.g. "color(srgb 1 1 1 / 0.92)" or "color(srgb 0.5 0.5 0.5)".
    var cm = str.match(/color\(\s*srgb\s+([^)]+)\)/i);
    if (cm) {
      var parts = cm[1].split('/');
      var rgb = parts[0].trim().split(/\s+/).map(parseFloat);
      var a = parts.length > 1 ? parseFloat(parts[1]) : 1;
      if (rgb.length >= 3) return { r: rgb[0] * 255, g: rgb[1] * 255, b: rgb[2] * 255, a: a };
    }
    return null;
  }

  function colorAttr(c) {
    return c ? 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')' : 'none';
  }

  function num(v) { return Math.round(v * 100) / 100; }

  function gradientDef(bgImage) {
    if (!bgImage || bgImage === 'none') return null;
    var m = bgImage.match(/linear-gradient\(([\s\S]+)\)\s*$/);
    if (!m) return null;
    var inner = m[1];
    var parts = [], depth = 0, start = 0;
    for (var i = 0; i <= inner.length; i++) {
      var ch = inner[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === ',' && depth === 0) || i === inner.length) {
        parts.push(inner.slice(start, i).trim());
        start = i + 1;
      }
    }
    var angle = 180;
    var stopParts = parts;
    var degMatch = parts[0] && parts[0].match(/^(-?\d+(?:\.\d+)?)deg$/);
    if (degMatch) { angle = parseFloat(degMatch[1]); stopParts = parts.slice(1); }
    else if (parts[0] && /^to\s+/.test(parts[0])) {
      var dirs = { top: 0, right: 90, bottom: 180, left: 270,
                   'top right': 45, 'bottom right': 135, 'bottom left': 225, 'top left': 315 };
      var key = parts[0].replace(/^to\s+/, '').trim();
      angle = dirs[key] !== undefined ? dirs[key] : 180;
      stopParts = parts.slice(1);
    }
    var stops = stopParts.map(function (s, idx, arr) {
      var cm = s.match(/rgba?\([^)]+\)|#[0-9a-f]+|[a-z]+/i);
      var pm = s.match(/(\d+(?:\.\d+)?)%/);
      return {
        color: parseRgb(cm ? cm[0] : '#000') || { r: 0, g: 0, b: 0, a: 1 },
        pos: pm ? parseFloat(pm[1]) / 100 : (arr.length > 1 ? idx / (arr.length - 1) : 0)
      };
    });
    // CSS gradient angle: 0deg points up. SVG x1/y1 -> x2/y2 in objectBoundingBox.
    var rad = (angle - 90) * Math.PI / 180;
    var dx = Math.cos(rad) * 0.5, dy = Math.sin(rad) * 0.5;
    var id = 'fgmg' + (++defCounter);
    var stopXml = stops.map(function (s) {
      return '<stop offset="' + num(s.pos) + '" stop-color="' + colorAttr(s.color) + '" stop-opacity="' + s.color.a + '"/>';
    }).join('');
    defs.push('<linearGradient id="' + id + '" x1="' + num(0.5 - dx) + '" y1="' + num(0.5 - dy) +
              '" x2="' + num(0.5 + dx) + '" y2="' + num(0.5 + dy) + '">' + stopXml + '</linearGradient>');
    return 'url(#' + id + ')';
  }

  function clipDef(x, y, w, h, rx) {
    var id = 'fgmc' + (++defCounter);
    defs.push('<clipPath id="' + id + '"><rect x="' + num(x) + '" y="' + num(y) +
              '" width="' + num(w) + '" height="' + num(h) +
              '" rx="' + num(rx) + '" ry="' + num(rx) + '"/></clipPath>');
    return id;
  }

  // Corner radius in px from a computed value like "12px", "50%" or "12px 8px".
  // Percentages resolve against width, then clamp to a pill/circle.
  function radiusPx(v, w, h) {
    var first = String(v || '0').split(/\s+/)[0];
    var n = parseFloat(first) || 0;
    if (first.slice(-1) === '%') n = n / 100 * w;
    return Math.min(n, Math.min(w, h) / 2);
  }

  // Outer box-shadows only. Returns [{dx, dy, blur, color}], CSS order.
  function parseShadows(str) {
    if (!str || str === 'none') return [];
    var parts = [], depth = 0, start = 0;
    for (var i = 0; i <= str.length; i++) {
      var ch = str[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === ',' && depth === 0) || i === str.length) { parts.push(str.slice(start, i)); start = i + 1; }
    }
    return parts.map(function (p) {
      if (/\binset\b/.test(p)) return null;
      var cm = p.match(/rgba?\([^)]+\)|color\([^)]+\)/);
      var color = cm ? parseRgb(cm[0]) : null;
      var n = (p.replace(cm ? cm[0] : '', '').match(/-?\d*\.?\d+(?=px)/g) || []).map(parseFloat);
      if (!color || color.a === 0 || n.length < 2) return null;
      return { dx: n[0], dy: n[1], blur: n[2] || 0, color: color };
    }).filter(Boolean);
  }

  // Figma's own export recipe for drop shadows (feColorMatrix → feOffset →
  // feGaussianBlur → feColorMatrix → feBlend, chained), which its SVG
  // importer turns back into native DROP_SHADOW effects.
  function shadowFilter(shadows, x, y, w, h) {
    var id = 'fgmf' + (++defCounter);
    var pad = 0;
    shadows.forEach(function (s) { pad = Math.max(pad, s.blur * 1.5 + Math.max(Math.abs(s.dx), Math.abs(s.dy))); });
    var f = '<filter id="' + id + '" x="' + num(x - pad) + '" y="' + num(y - pad) +
            '" width="' + num(w + 2 * pad) + '" height="' + num(h + 2 * pad) +
            '" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">' +
            '<feFlood flood-opacity="0" result="BackgroundImageFix"/>';
    var prev = 'BackgroundImageFix';
    // CSS paints the first shadow on top; SVG chain paints in order → reverse.
    shadows.slice().reverse().forEach(function (s, k) {
      var res = 'effect' + (k + 1) + '_dropShadow';
      f += '<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha' + (k + 1) + '"/>' +
           '<feOffset dx="' + num(s.dx) + '" dy="' + num(s.dy) + '"/>' +
           '<feGaussianBlur stdDeviation="' + num(s.blur / 2) + '"/>' +
           '<feColorMatrix type="matrix" values="0 0 0 0 ' + num(s.color.r / 255) + ' 0 0 0 0 ' + num(s.color.g / 255) +
           ' 0 0 0 0 ' + num(s.color.b / 255) + ' 0 0 0 ' + num(s.color.a) + ' 0"/>' +
           '<feBlend mode="normal" in2="' + prev + '" result="' + res + '"/>';
      prev = res;
    });
    defs.push(f + '<feBlend mode="normal" in="SourceGraphic" in2="' + prev + '" result="shape"/></filter>');
    return 'url(#' + id + ')';
  }

  function blobToDataUri(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  // <script src=".design/figma-images.js"> is optional; load it on demand.
  var embeddedLoad = null;
  function loadEmbeddedImages() {
    if (!embeddedLoad) {
      embeddedLoad = new Promise(function (resolve) {
        if (!designDir) return resolve();
        var s = document.createElement('script');
        s.src = designDir + 'figma-images.js';
        s.onload = s.onerror = function () { resolve(); };
        document.head.appendChild(s);
      });
    }
    return embeddedLoad;
  }

  function embeddedKey(src) {
    var s = decodeURI(src), root = decodeURI(projectRoot);
    return root && s.indexOf(root) === 0 ? s.slice(root.length) : s;
  }

  function resolveImage(src) {
    if (!src) return Promise.resolve(null);
    if (src.indexOf('data:') === 0) return Promise.resolve(src);
    if (!(src in imageData)) {
      // A file:// page can't fetch() file:// URLs (and logs a CORS error
      // trying), so go straight to the embedded copy there.
      var direct = location.protocol === 'file:' && src.indexOf('file:') === 0
        ? Promise.reject(new Error('file://'))
        : fetch(src).then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); }).then(blobToDataUri);
      imageData[src] = direct
        .catch(function () {
          return loadEmbeddedImages().then(function () {
            return (window.__figmaImages && window.__figmaImages[embeddedKey(src)]) || null;
          });
        })
        .then(function (d) { if (!d) unreadable.push(src); return d; });
    }
    return imageData[src];
  }

  function bgUrl(cs) {
    var m = cs.backgroundImage && cs.backgroundImage.match(/url\((['"]?)(.*?)\1\)/);
    return m ? m[2] : null;
  }

  function emitImage(src, x, y, w, h, rx, par, out) {
    var data = imageData[src];
    var el = data
      ? '<image x="' + num(x) + '" y="' + num(y) + '" width="' + num(w) + '" height="' + num(h) +
        '" href="' + data + '" preserveAspectRatio="' + par + '"/>'
      : '<rect x="' + num(x) + '" y="' + num(y) + '" width="' + num(w) + '" height="' + num(h) +
        '" rx="' + num(rx) + '" ry="' + num(rx) + '" fill="#D1D1D6"/>';
    out.push(rx > 0 && data ? '<g clip-path="url(#' + clipDef(x, y, w, h, rx) + ')">' + el + '</g>' : el);
  }

  function lineRectsForText(textNode) {
    var text = textNode.textContent;
    if (!text.trim()) return [];
    var range = document.createRange();
    range.selectNodeContents(textNode);
    var rects = Array.prototype.slice.call(range.getClientRects());
    if (rects.length === 0) return [];
    if (rects.length === 1) return [{ text: text, rect: rects[0] }];
    // Multi-line: binary-search per line to find character span
    var lines = [];
    var len = text.length;
    var offset = 0;
    for (var li = 0; li < rects.length; li++) {
      var targetTop = rects[li].top;
      while (offset < len && /\s/.test(text[offset])) offset++;
      var lo = offset, hi = len;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        range.setStart(textNode, offset);
        range.setEnd(textNode, mid);
        var rs = range.getClientRects();
        var lastTop = rs.length ? rs[rs.length - 1].top : targetTop;
        if (Math.abs(lastTop - targetTop) < 1) lo = mid;
        else hi = mid - 1;
      }
      var lineEnd = lo > offset ? lo : Math.min(offset + 1, len);
      var lineText = text.slice(offset, lineEnd);
      if (lineText.trim().length) lines.push({ text: lineText, rect: rects[li] });
      offset = lineEnd;
    }
    return lines;
  }

  function emitTextNode(textNode, ox, oy, out) {
    var parent = textNode.parentElement;
    if (!parent) return;
    var cs = getComputedStyle(parent);
    var color = parseRgb(cs.color);
    var family = (cs.fontFamily || '').replace(/"/g, "'");
    var size = parseFloat(cs.fontSize);
    var weight = cs.fontWeight;
    var align = cs.textAlign;
    var lines = lineRectsForText(textNode);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var lx = ln.rect.left - ox;
      var ly = ln.rect.top - oy;
      // Baseline ≈ font cap-height. Center font within line box, then drop to baseline.
      var ty = ly + (ln.rect.height - size) / 2 + size * 0.82;
      var tx = lx;
      var anchor = 'start';
      if (align === 'center') { anchor = 'middle'; tx = lx + ln.rect.width / 2; }
      else if (align === 'right' || align === 'end') { anchor = 'end'; tx = lx + ln.rect.width; }
      out.push('<text x="' + num(tx) + '" y="' + num(ty) +
               '" font-family="' + esc(family) +
               '" font-size="' + num(size) +
               '" font-weight="' + weight +
               '" fill="' + colorAttr(color) +
               (color && color.a < 1 ? '" fill-opacity="' + color.a : '') +
               '" text-anchor="' + anchor +
               '" xml:space="preserve">' + esc(ln.text) + '</text>');
    }
  }

  function emit(node, ox, oy, out) {
    if (node.nodeType === 3) { emitTextNode(node, ox, oy, out); return; }
    if (node.nodeType !== 1) return;
    if (node.dataset && 'figmaExportIgnore' in node.dataset) return;
    var cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    var op = parseFloat(cs.opacity);
    if (op === 0) return;
    var tag = node.tagName.toLowerCase();
    var r = node.getBoundingClientRect();
    var x = r.left - ox, y = r.top - oy, w = r.width, h = r.height;
    if (w <= 0 || h <= 0) return;

    // CSS mask icon (Iconify SVG used as `mask` with a `background-color`
    // tint — used by the iOS floating tab bar and the Android bottom nav).
    // Figma's SVG paste can't read CSS `mask`, so without this the icon
    // appears as a solid filled rectangle. Pre-fetched SVG markup is
    // recolored with the element's background-color and inlined.
    var maskImg = (cs.maskImage && cs.maskImage !== 'none') ? cs.maskImage : cs.webkitMaskImage;
    var maskMatch = maskImg && maskImg.match(/url\((['"]?)([^'")]+)\1\)/);
    if (maskMatch && window.__figmaMaskCache && window.__figmaMaskCache[maskMatch[2]]) {
      var maskSvg = window.__figmaMaskCache[maskMatch[2]];
      var maskBg = parseRgb(cs.backgroundColor);
      var maskColor = (maskBg && maskBg.a > 0 ? maskBg : null) || parseRgb(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
      var maskColorVal = colorAttr(maskColor);
      var vbm = maskSvg.match(/viewBox\s*=\s*"([^"]+)"/i);
      var vb = vbm ? vbm[1].split(/\s+/).map(parseFloat) : [0, 0, 24, 24];
      var inner = maskSvg.replace(/^[\s\S]*?<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '');
      inner = inner.replace(/currentColor/g, maskColorVal);
      var msx = w / (vb[2] || 24), msy = h / (vb[3] || 24);
      if (op < 1) out.push('<g opacity="' + op + '">');
      out.push('<g transform="translate(' + num(x - vb[0] * msx) + ',' + num(y - vb[1] * msy) +
               ') scale(' + num(msx) + ',' + num(msy) + ')" fill="' + maskColorVal +
               '" fill-opacity="' + maskColor.a + '">' + inner + '</g>');
      if (op < 1) out.push('</g>');
      return;
    }

    if (tag === 'svg') {
      // Inline <svg> — embed the element verbatim so its own fill/stroke/
      // viewBox attributes survive. Wrap in a <g transform="translate(...)">
      // for positioning (don't mutate the inner svg's attributes — duplicate
      // width/height would produce invalid XML that Figma rejects).
      // Resolve `currentColor` to the actual text color at export time:
      // Figma's SVG paste parser doesn't reliably propagate color context,
      // so unresolved `currentColor` falls back to black.
      var fillRgb = parseRgb(cs.fill) || parseRgb(cs.color);
      var colorVal = fillRgb ? colorAttr(fillRgb) : 'black';
      // Strip any existing width/height (may come from CSS, not attrs) and
      // inject the computed render size, otherwise a nested <svg> without
      // width/height defaults to 100% of the root viewport in Figma.
      // Also resolve currentColor so strokes/fills don't fall back to black.
      // Only strip width/height on the OUTER <svg ...> opening tag — a
      // global replace also wipes width/height from inner <rect>/<image>
      // elements (e.g. status-bar cellular/battery rects), erasing them.
      var markup = node.outerHTML.replace(
        /^<svg\b([^>]*)>/i,
        function (_m, attrs) {
          var stripped = attrs.replace(/\s(?:width|height)\s*=\s*"[^"]*"/gi, '');
          // Preserve existing fill (incl. fill="none" for outline icons).
          // Only inject computed color when no fill attribute is present.
          // currentColor in attrs/children is resolved by the global replace below.
          var hasFill = /\sfill\s*=\s*"/i.test(stripped);
          var fillAttr = hasFill ? '' : ' fill="' + colorVal + '"';
          return '<svg width="' + num(w) + '" height="' + num(h) + '"' + fillAttr + stripped + '>';
        }
      ).replace(/currentColor/g, colorVal);
      if (op < 1) out.push('<g opacity="' + op + '">');
      out.push('<g transform="translate(' + num(x) + ',' + num(y) + ')">' + markup + '</g>');
      if (op < 1) out.push('</g>');
      return;
    }

    // <img> — embedded bytes (see resolveImage), clipped to its border-radius,
    // honoring object-fit (browser default `fill` stretches).
    if (tag === 'img') {
      var fit = cs.objectFit;
      var imgPar = fit === 'cover' ? 'xMidYMid slice' : (fit === 'contain' || fit === 'scale-down') ? 'xMidYMid meet' : 'none';
      emitImage(node.currentSrc || node.src, x, y, w, h, radiusPx(cs.borderTopLeftRadius, w, h), imgPar, out);
      return;
    }

    if (op < 1) out.push('<g opacity="' + op + '">');

    // Background / border rect (skip fully transparent fills/strokes)
    var bg = parseRgb(cs.backgroundColor);
    if (bg && bg.a === 0) bg = null;
    var grad = gradientDef(cs.backgroundImage);
    var borderW = parseFloat(cs.borderTopWidth) || 0;
    var borderC = borderW > 0 ? parseRgb(cs.borderTopColor) : null;
    if (borderC && borderC.a === 0) borderC = null;
    // Clamp rx to min(w,h)/2 — CSS border-radius: 9999px renders as a
    // pill, but SVG clamps rx and ry independently, producing an ellipse.
    // radiusPx also resolves percentages (50% → circle).
    var rx = radiusPx(cs.borderTopLeftRadius, w, h);
    var imgUrl = bgUrl(cs);
    if (grad || bg || (borderW && borderC)) {
      var fillVal = grad || (bg ? colorAttr(bg) : 'none');
      var fillOp = (!grad && bg) ? bg.a : 1;
      var strokeAttr = (borderW && borderC)
        ? ' stroke="' + colorAttr(borderC) + '" stroke-opacity="' + borderC.a + '" stroke-width="' + num(borderW) + '"'
        : '';
      var shadows = parseShadows(cs.boxShadow);
      var filterAttr = shadows.length ? ' filter="' + shadowFilter(shadows, x, y, w, h) + '"' : '';
      out.push('<rect x="' + num(x) + '" y="' + num(y) +
               '" width="' + num(w) + '" height="' + num(h) +
               '" rx="' + num(rx) + '" ry="' + num(rx) +
               '" fill="' + fillVal + '" fill-opacity="' + fillOp + '"' + strokeAttr + filterAttr + '/>');
    }
    if (imgUrl) {
      var bgSize = cs.backgroundSize;
      var bgPar = bgSize === 'cover' ? 'xMidYMid slice' : bgSize === '100% 100%' ? 'none' : 'xMidYMid meet';
      emitImage(imgUrl, x, y, w, h, rx, bgPar, out);
    }

    // Children, possibly clipped by overflow.
    // SVG paint order is strict DOM order — CSS z-index is ignored.
    // Stable-sort element children by computed z-index so stacked
    // positioned layers (e.g. status-bar over .ambient) paint correctly.
    var kids = Array.prototype.slice.call(node.childNodes);
    var ordered = kids.map(function (c, idx) {
      var z = 0;
      if (c.nodeType === 1) {
        var zs = getComputedStyle(c).zIndex;
        if (zs && zs !== 'auto') { var zn = parseInt(zs, 10); if (!isNaN(zn)) z = zn; }
      }
      return { node: c, idx: idx, z: z };
    });
    ordered.sort(function (a, b) { return (a.z - b.z) || (a.idx - b.idx); });
    var childOut = [];
    for (var i = 0; i < ordered.length; i++) {
      emit(ordered[i].node, ox, oy, childOut);
    }
    var needsClip = (cs.overflow === 'hidden' || cs.overflow === 'auto' || cs.overflow === 'scroll' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden');
    if (needsClip && childOut.length) {
      var cid = clipDef(x, y, w, h, rx);
      out.push('<g clip-path="url(#' + cid + ')">');
      out.push(childOut.join(''));
      out.push('</g>');
    } else {
      out.push(childOut.join(''));
    }

    if (op < 1) out.push('</g>');
  }

  // Builds the SVG string for .device (async: pre-fetches mask icons and
  // image bytes so emit() can stay synchronous).
  async function buildSvg(root) {
    defs = [];
    defCounter = 0;
    unreadable = [];
    var maskUrls = {}, imageSrcs = {};
    [root].concat(Array.prototype.slice.call(root.querySelectorAll('*'))).forEach(function (n) {
      var s = getComputedStyle(n);
      var mi = (s.maskImage && s.maskImage !== 'none') ? s.maskImage : s.webkitMaskImage;
      var m = mi && mi.match(/url\((['"]?)([^'")]+)\1\)/);
      if (m) maskUrls[m[2]] = true;
      if (n.tagName.toLowerCase() === 'img') { var src = n.currentSrc || n.src; if (src) imageSrcs[src] = true; }
      var bu = bgUrl(s);
      if (bu) imageSrcs[bu] = true;
    });
    // Pre-fetch CSS mask SVG icons so emit() can inline them
    // synchronously. Each cached entry maps mask url -> raw SVG text.
    var maskCache = {};
    await Promise.all(Object.keys(maskUrls).map(function (u) {
      return fetch(u).then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function (t) { maskCache[u] = t; })
        .catch(function () { maskCache[u] = null; });
    }));
    window.__figmaMaskCache = maskCache;
    await Promise.all(Object.keys(imageSrcs).map(function (u) {
      return resolveImage(u).then(function (d) { imageData[u] = d; });
    }));
    var r = root.getBoundingClientRect();
    var out = [];
    emit(root, r.left, r.top, out);
    return '<svg xmlns="' + SVG_NS + '" width="' + num(r.width) + '" height="' + num(r.height) +
           '" viewBox="0 0 ' + num(r.width) + ' ' + num(r.height) + '">' +
           (defs.length ? '<defs>' + defs.join('') + '</defs>' : '') +
           out.join('') +
           '</svg>';
  }

  // Clipboard API → execCommand → file download. Returns which one worked.
  async function deliver(svgPromise) {
    // Passing the promise into ClipboardItem keeps the click's user gesture
    // alive across the async build (Safari requires that).
    if (navigator.clipboard && window.ClipboardItem && navigator.clipboard.write) {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          'text/plain': svgPromise.then(function (s) { return new Blob([s], { type: 'text/plain' }); })
        })]);
        return 'copied';
      } catch (e) { /* fall through */ }
    }
    var svg = await svgPromise;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(svg); return 'copied'; } catch (e) { /* fall through */ }
    }
    try {
      var ta = document.createElement('textarea');
      ta.value = svg;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) return 'copied';
    } catch (e) { /* fall through */ }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    a.download = (document.title || 'mockup').replace(/[^\w-]+/g, '-') + '.svg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return 'downloaded';
  }

  function showToast(msg, isError) {
    var t = document.querySelector('.figma-export-toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    t.style.color = isError ? '#ff9f9f' : '#fff';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  window.__copyDesignToFigma = async function () {
    try {
      var root = document.querySelector('.device');
      if (!root) { showToast('No .device frame found', true); return; }
      var svgPromise = buildSvg(root);
      svgPromise.then(function (s) { window.__figmaSvg = s; });
      var how = await deliver(svgPromise);
      var msg = how === 'copied'
        ? 'Copied — paste into Figma (Cmd+V)'
        : 'Clipboard blocked — saved an .svg; drag it onto the Figma canvas';
      if (unreadable.length) {
        var uniq = unreadable.filter(function (u, i) { return unreadable.indexOf(u) === i; });
        console.warn('[figma-export] ' + uniq.length + ' image(s) could not be embedded (grey placeholder used):\n' + uniq.join('\n') +
          '\nOpen this page over http(s) (python3 -m http.server) or run scripts/embed_figma_images.py from the make-mobile-design skill.');
        msg += ' · ' + uniq.length + ' image(s) not embedded (see console)';
      }
      showToast(msg, !!unreadable.length);
    } catch (err) {
      console.error('[figma-export]', err);
      showToast('Export failed — see console', true);
    }
  };
})();
