/** 둥글게 다듬은 둘레 (차이킨 3번) */
function smoothRing(pts, iter) {
  let p = pts;
  for (let t = 0; t < iter; t++) {
    const q = [];
    for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i];
      const [bx, by] = p[(i + 1) % p.length];
      q.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    p = q;
  }
  return p;
}
/** 모양 안에 고른 평행 빗금 (dir: 선 방향 단위벡터) */
function hatchIn(ctx, shape, dx, dy, gap, width, color) {
  const nx = -dy;
  const ny = dx;
  let c0 = Infinity, c1 = -Infinity, l0 = Infinity, l1 = -Infinity;
  for (const [x, y] of shape) {
    const c = x * nx + y * ny;
    const l = x * dx + y * dy;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
    if (l < l0) l0 = l;
    if (l > l1) l1 = l;
  }
  ctx.save();
  polyPath(ctx, shape, 1);
  ctx.clip();
  ctx.beginPath();
  for (let c = Math.ceil(c0 / gap) * gap; c <= c1; c += gap) {
    ctx.moveTo(nx * c + dx * (l0 - 5), ny * c + dy * (l0 - 5));
    ctx.lineTo(nx * c + dx * (l1 + 5), ny * c + dy * (l1 + 5));
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.stroke();
  ctx.restore();
}
function beamAxis(shape) {
  let mx = 0, my = 0;
  for (const [x, y] of shape) { mx += x; my += y; }
  mx /= shape.length; my /= shape.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of shape) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return [Math.cos(a), Math.sin(a)];
}
