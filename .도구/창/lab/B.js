/** 재해 지대 하나: 매끈한 둘레 + 안쪽 빗금 띠 (영역 색띠처럼) + 아주 옅은 빗금 */
function drawWreck(ctx, r, seed) {
  const k = 1 - clamp(r.heal || 0, 0, 1);
  if (k <= 0.02) return;
  const shape = smoothRing(r.pts, 3);
  const [ax, ay] = beamAxis(shape);
  // 안쪽 띠: 테두리를 굵게 긋고 모양으로 잘라 안쪽 절반만
  const band = document.createElement('canvas');
  const xs = shape.map((p) => p[0]);
  const ys = shape.map((p) => p[1]);
  const bx = Math.floor(Math.min(...xs)) - 4;
  const by = Math.floor(Math.min(...ys)) - 4;
  band.width = Math.ceil(Math.max(...xs)) - bx + 8;
  band.height = Math.ceil(Math.max(...ys)) - by + 8;
  const b = band.getContext('2d');
  b.translate(-bx, -by);
  hatchIn(b, shape, -ay, ax, 6, 1.1, 'rgba(88,66,44,1)');
  b.globalCompositeOperation = 'destination-in';
  polyPath(b, shape, 1);
  b.lineWidth = 48;
  b.lineJoin = 'round';
  b.strokeStyle = '#000';
  b.stroke();
  ctx.save();
  ctx.globalAlpha = 0.5 * k;
  ctx.drawImage(band, bx, by);
  ctx.restore();
  hatchIn(ctx, shape, -ay, ax, 12, 0.9, `rgba(88,66,44,${0.2 * k})`);
  ctx.save();
  polyPath(ctx, shape, 1);
  ctx.strokeStyle = `rgba(88,66,44,${0.85 * k})`;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}
