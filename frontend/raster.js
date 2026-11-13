"use strict";

(() => {
  const slideWidth = 1920;
  const slideHeight = 1080;
  const sans = '"DM Sans", "Microsoft YaHei", "PingFang SC", sans-serif';
  const serif = '"Noto Serif SC", "Songti SC", SimSun, serif';
  const sampleImages = new Map();

  function loadImage(url) {
    if (!url) return Promise.resolve(null);
    const path = new URL(url, location.href);
    const sample = path.origin === location.origin && path.pathname.startsWith("/frontend/samples/");
    if (sample && sampleImages.has(path.href)) return sampleImages.get(path.href);
    const result = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("无法打开图片素材。"));
      image.src = url;
    });
    if (sample) {
      sampleImages.set(path.href, result);
      result.catch(() => sampleImages.delete(path.href));
    }
    return result;
  }

  function makeCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.imageSmoothingQuality = "high";
    return context;
  }

  function png(context) {
    return new Promise((resolve, reject) => {
      context.canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("无法创建 PNG 文件。"));
      }, "image/png");
    });
  }

  function drawCover(context, image, crop, width, height) {
    const { x, y, width: sourceWidth, height: sourceHeight } = crop || {
      x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight
    };
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const visibleWidth = width / scale;
    const visibleHeight = height / scale;
    context.drawImage(image,
      x + (sourceWidth - visibleWidth) / 2, y + (sourceHeight - visibleHeight) / 2,
      visibleWidth, visibleHeight, 0, 0, width, height);
  }

  async function cropImage({ url, crop }, width, height) {
    const image = await loadImage(url);
    const context = makeCanvas(width, height);
    drawCover(context, image, crop, width, height);
    return png(context);
  }

  function wrapText(context, value, width) {
    const lines = [];
    for (const paragraph of String(value ?? "").split(/\r?\n/)) {
      let line = "";
      // Keep Latin words together while still allowing Chinese text and long URLs to wrap.
      for (const token of paragraph.match(/[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*|\s+|[^]/gu) || []) {
        if (context.measureText(line + token).width <= width) {
          line += token;
          continue;
        }
        if (line.trim()) lines.push(line.trimEnd());
        line = "";
        for (const character of token.trimStart()) {
          if (line && context.measureText(line + character).width > width) {
            lines.push(line);
            line = "";
          }
          line += character;
        }
      }
      lines.push(line.trim());
    }
    return lines;
  }

  function textBlock(context, value, width, { size, minimum = size, limit = 2, weight = 500, family = sans }) {
    let lines;
    let font;
    for (; size >= minimum; size--) {
      font = `${weight} ${size}px ${family}`;
      context.font = font;
      lines = wrapText(context, value, width);
      if (lines.length <= limit || size === minimum) break;
    }
    if (lines.length > limit) {
      lines.length = limit;
      let last = Array.from(lines[limit - 1]);
      while (last.length && context.measureText(last.join("") + "…").width > width) last.pop();
      lines[limit - 1] = last.join("") + "…";
    }
    const lineHeight = size * 1.28;
    return { lines, font, lineHeight, height: lines.length * lineHeight };
  }

  function drawText(context, block, x, top, color) {
    context.font = block.font;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillStyle = color;
    block.lines.forEach((line, index) => context.fillText(line, x, top + index * block.lineHeight));
  }

  function drawMark(context, image, x, bottom, maxWidth, maxHeight, alignRight = false) {
    const scale = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, alignRight ? x - width : x, bottom - height, width, height);
  }

  async function poster({ width, height, photo, layout = "bottom", fitted = false, title, subtitle, date, logo, qr }) {
    const [background, logoImage, qrImage] = await Promise.all([
      loadImage(photo?.url), loadImage(logo), loadImage(qr)
    ]);
    const context = makeCanvas(width, height);
    context.fillStyle = "#243128";
    context.fillRect(0, 0, width, height);
    if (background) {
      if (fitted && background.naturalWidth * height !== background.naturalHeight * width) {
        context.save();
        context.filter = `blur(${Math.round(Math.min(width, height) * .045)}px)`;
        drawCover(context, background, photo.crop, width, height);
        context.restore();
        const scale = Math.min(width / background.naturalWidth, height / background.naturalHeight);
        const drawnWidth = background.naturalWidth * scale;
        const drawnHeight = background.naturalHeight * scale;
        const x = layout === "left" ? width - drawnWidth : (width - drawnWidth) / 2;
        context.drawImage(background, x, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
      } else drawCover(context, background, photo.crop, width, height);
    }

    const left = layout === "left";
    const top = layout === "top";
    const wash = left ? context.createLinearGradient(width * .74, 0, 0, 0)
      : top ? context.createLinearGradient(0, height * .54, 0, 0)
      : context.createLinearGradient(0, height * .2, 0, height);
    wash.addColorStop(0, "rgba(18, 23, 18, 0)");
    wash.addColorStop(.51, "rgba(18, 23, 18, .33)");
    wash.addColorStop(1, "rgba(18, 23, 18, .94)");
    context.fillStyle = wash;
    context.fillRect(0, 0, width, height);

    const unit = Math.min(width, height);
    const margin = unit * .085;
    const landscape = width > height * 1.35;
    const textWidth = left ? width * .43 : landscape ? width * .60 : width - margin * 2;
    const blocks = [
      [title, { size: Math.round(unit * .099), minimum: Math.round(unit * .056), limit: 3, weight: 700, family: serif }, "#fff3d9"],
      [subtitle, { size: Math.round(unit * .034), minimum: Math.round(unit * .025) }, "#fff3d9"],
      [date, { size: Math.round(unit * .029), minimum: Math.round(unit * .023) }, "#f3ddab"]
    ].filter(([value]) => value).map(([value, options, color]) => [textBlock(context, value, textWidth, options), color]);
    const lineGap = unit * .012;
    const markHeight = unit * .125;
    const markSpace = logoImage || qrImage ? markHeight + unit * .04 : 0;
    const blockHeight = blocks.reduce((height, [block]) => height + block.height + lineGap, -lineGap);
    let cursor = top ? margin + unit * .04
      : left ? Math.max(margin + unit * .04, (height - markSpace - blockHeight) / 2)
      : height - margin - markSpace - blockHeight;
    if (blocks.length) {
      context.fillStyle = "#ebcd8c";
      context.fillRect(margin, cursor - unit * .038, unit * .08, unit * .004);
    }
    for (const [block, color] of blocks) {
      drawText(context, block, margin, cursor, color);
      cursor += block.height + lineGap;
    }
    if (logoImage) drawMark(context, logoImage, margin, height - margin, unit * .25, markHeight);
    if (qrImage) drawMark(context, qrImage, width - margin, height - margin, markHeight, markHeight, true);
    return png(context);
  }

  const slideStyles = {
    商务深蓝: { dark: "#101d34", light: "#223d64", text: "#f3f6fc", secondary: "#c0cee2", accent: "#84b5ed", panel: "#213552" },
    科技: { dark: "#12283a", light: "#225253", text: "#e8fcf3", secondary: "#b3d8d0", accent: "#86e4ca", panel: "#1a4148" },
    极简: { dark: "#f0efe9", light: "#faf9f2", text: "#23344d", secondary: "#455971", accent: "#336da2", panel: "#e0e7ed" }
  };

  function drawSystems(context, x, top, palette) {
    const nodeWidth = 232;
    const nodeHeight = 88;
    const gap = 89;
    for (const [index, name] of ["SAP", "中间件", "WMS"].entries()) {
      const left = x + index * (nodeWidth + gap);
      context.beginPath();
      context.roundRect(left, top, nodeWidth, nodeHeight, 10);
      context.fillStyle = palette.panel;
      context.fill();
      context.lineWidth = 2;
      context.strokeStyle = palette.accent;
      context.stroke();
      context.font = `650 34px ${sans}`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = palette.text;
      context.fillText(name, left + nodeWidth / 2, top + nodeHeight / 2);
      if (index === 2) continue;
      const start = left + nodeWidth + 16;
      const end = left + nodeWidth + gap - 16;
      const center = top + nodeHeight / 2;
      context.beginPath();
      context.moveTo(start, center);
      context.lineTo(end, center);
      context.lineTo(end - 11, center - 8);
      context.moveTo(end, center);
      context.lineTo(end - 11, center + 8);
      context.stroke();
    }
  }

  async function slide({ index, title, detail, technical, revision = 0, style }) {
    const context = makeCanvas(slideWidth, slideHeight);
    const palette = Object.hasOwn(slideStyles, style) ? slideStyles[style] : slideStyles.商务深蓝;
    const isCover = index === 0 || index === 5;
    const start = revision % 2 ? .28 : .57;
    const backdrop = context.createLinearGradient(slideWidth * start, 0, slideWidth, slideHeight);
    backdrop.addColorStop(0, palette.dark);
    backdrop.addColorStop(1, palette.light);
    context.fillStyle = backdrop;
    context.fillRect(0, 0, slideWidth, slideHeight);
    context.fillStyle = palette.accent;
    context.fillRect(156, 150, 94, 5);

    const left = 156;
    const width = 1532;
    const heading = textBlock(context, title, width, { size: isCover ? 116 : 100, minimum: 66, limit: technical ? 2 : 3, weight: 750 });
    const description = textBlock(context, detail, width, { size: 41, minimum: 33, limit: 2 });
    const headingTop = technical ? 312 : 430 - (heading.height - heading.lineHeight) / 2;
    const caption = `${String(index + 1).padStart(2, "0")} / ${revision ? `版本 ${revision + 1}` : "项目汇报"}`;
    drawText(context, textBlock(context, caption, width, { size: 30 }), left, 189, palette.secondary);
    drawText(context, heading, left, headingTop, palette.text);
    const afterHeading = headingTop + heading.height + 40;
    if (technical) drawSystems(context, left, afterHeading, palette);
    drawText(context, description, left, afterHeading + (technical ? 129 : 0), palette.secondary);
    return png(context);
  }

  // PNGs are already compressed. Store their original bytes in a UTF-8 ZIP.
  async function zip(entries) {
    const table = Uint32Array.from({length: 256}, (_, n) => {
      for (let bit = 0; bit < 8; bit++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
      return n;
    });
    const encode = new TextEncoder();
    const parts = [], directory = [];
    let offset = 0, directorySize = 0;
    for (const {name, blob} of entries) {
      const filename = encode.encode(name);
      let crc = 0xffffffff;
      for (const byte of new Uint8Array(await blob.arrayBuffer())) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
      crc = (crc ^ 0xffffffff) >>> 0;
      const header = new DataView(new ArrayBuffer(30));
      header.setUint32(0, 0x04034b50, true);
      header.setUint16(4, 20, true);
      header.setUint16(6, 0x800, true);
      header.setUint16(12, 33, true); // 1980-01-01
      header.setUint32(14, crc, true);
      header.setUint32(18, blob.size, true);
      header.setUint32(22, blob.size, true);
      header.setUint16(26, filename.length, true);
      const record = new DataView(new ArrayBuffer(46));
      record.setUint32(0, 0x02014b50, true);
      record.setUint16(4, 20, true);
      new Uint8Array(record.buffer).set(new Uint8Array(header.buffer, 4, 26), 6);
      record.setUint32(42, offset, true);
      parts.push(header.buffer, filename, blob);
      directory.push(record.buffer, filename);
      offset += header.byteLength + filename.length + blob.size;
      directorySize += record.byteLength + filename.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end.buffer], {type: "application/zip"});
  }

  window.workspaceRaster = { crop: cropImage, poster, slide, zip };
})();
