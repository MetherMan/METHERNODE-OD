/** 재해 지대 하나: 매끈한 둘레 + 굵고 성긴 고른 빗금 (지도를 멀리서 봐도 빗금으로 보이게) */
function drawWreck(ctx, r, seed) {
  const k = 1 - clamp(r.heal || 0, 0, 1);
  if (k <= 0.02) return;
  const shape = smoothRing(r.pts, 3);
  const [ax, ay] = beamAxis(shape);
  hatchIn(ctx, shape, -ay, ax, 26, 2.2, `rgba(88,66,44,${0.42 * k})`);
  ctx.save();
  polyPath(ctx, shape, 1);
  ctx.setLineDash([16, 9]);
  ctx.strokeStyle = `rgba(88,66,44,${0.8 * k})`;
  ctx.lineWidth = 2.6;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}
