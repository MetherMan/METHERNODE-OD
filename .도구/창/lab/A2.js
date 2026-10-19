/** 재해 지대 하나: 매끈한 둘레 + 빛줄기를 가로지르는 고른 빗금 */
function drawWreck(ctx, r, seed) {
  const k = 1 - clamp(r.heal || 0, 0, 1);
  if (k <= 0.02) return;
  const shape = smoothRing(r.pts, 3);
  const [ax, ay] = beamAxis(shape);
  hatchIn(ctx, shape, -ay, ax, 9, 1, `rgba(88,66,44,${0.42 * k})`);
  ctx.save();
  polyPath(ctx, shape, 1);
  ctx.strokeStyle = `rgba(88,66,44,${0.85 * k})`;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}
