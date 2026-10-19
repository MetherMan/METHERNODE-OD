/** 재해 지대 하나: 매끈한 둘레 + 빛줄기를 가로지르는 성긴 빗금 + 둘레 안쪽 옅은 띠.
 *  골(자국) 양옆은 빗금을 비워 골이 깨끗한 바닥 위에 놓이게. 아물수록 빗금이 성겨지고 옅어짐 */
function drawWreck(ctx, r, seed, lines) {
  const heal = clamp(r.heal || 0, 0, 1);
  const k = 1 - heal;
  if (k <= 0.02) return;
  const ink = (a) => `rgba(96,64,42,${a})`;
  const shape = smoothRing(r.pts, 3);
  const [ax, ay] = beamAxis(shape);
  // 1) 둘레 안쪽 옅은 띠 (안쪽 절반만)
  ctx.save();
  polyPath(ctx, shape, 1);
  ctx.clip();
  ctx.strokeStyle = ink(0.13 * k);
  ctx.lineWidth = 36;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
  // 2) 빗금: 빛줄기를 가로질러
  hatchIn(ctx, shape, -ay, ax, 24 * (1 + heal), 2.2, ink(0.4 * k));
  // 3) 골 양옆 비우기 (이 그림은 따로 된 캔버스라 재해 지대만 지워짐)
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  for (const t of lines || []) {
    const p = t.pts;
    let total = 0;
    for (let i = 1; i < p.length; i++) total += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    let run = 0;
    for (let i = 1; i < p.length; i++) {
      const seg = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      const f = total ? (run + seg / 2) / total : 0;
      run += seg;
      ctx.lineWidth = (t.w0 || 8) + ((t.w1 == null ? 1 : t.w1) - (t.w0 || 8)) * f + 32;
      ctx.beginPath();
      ctx.moveTo(p[i - 1][0], p[i - 1][1]);
      ctx.lineTo(p[i][0], p[i][1]);
      ctx.stroke();
    }
  }
  ctx.restore();
  // 4) 실선 둘레
  ctx.save();
  polyPath(ctx, shape, 1);
  ctx.strokeStyle = ink(0.8 * Math.pow(k, 0.7));
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}
