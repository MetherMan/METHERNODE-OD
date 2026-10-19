/** 재해 지대 하나: 범위만 알려 주는 아주 옅은 안내선 (지금은 생명체가 잘 사는 땅) */
function drawWreck(ctx, r, seed, lines) {
  const heal = clamp(r.heal || 0, 0, 1);
  if (heal >= 0.98) return;
  const shape = detailPts({ ...r, detail: r.detail || 0.6 });
  ctx.save();
  polyPath(ctx, shape, 1);

  ctx.strokeStyle = `rgba(92,70,52,${0.42 * (1 - 0.4 * heal)})`;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}
