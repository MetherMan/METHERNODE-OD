/** 재해 지대 하나: 영역과 같은 말투 (각진 경계 + 안쪽 잿빛 띠 + 먹선), 속은 비움 */
function drawWreck(ctx, r, seed, lines) {
  const k = 1 - clamp(r.heal || 0, 0, 1);
  if (k <= 0.02) return;
  const shape = detailPts({ ...r, detail: r.detail || 0.6 });
  ctx.save();
  polyPath(ctx, shape, 1);
  ctx.clip();
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 10;
  ctx.strokeStyle = `rgba(150,138,122,${0.55 * k})`;
  ctx.lineWidth = 32;
  ctx.stroke();
  ctx.strokeStyle = `rgba(74,62,52,${0.9 * k})`;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.restore();
}
