// 시험 그리기: main.js 의 drawWreck 자리에 /lab/<이름>.js 를 끼워 넣고, 지금 저장된 라하니아 지형을 실제 렌더러로 그려 out/ 에 PNG 로 남김
window.labRender = async (name, heal, mapFile = 'The Archive - 자료/라하니아.지형.json') => {
  const base = await (await fetch('/vault/.obsidian/plugins/mn-sekaipan/main.js?t=' + Date.now())).text();
  const common = await (await fetch('/lab/common.js?t=' + Date.now())).text();
  const json = JSON.parse(await (await fetch(url(mapFile) + '?t=' + Date.now())).text());
  const a = base.indexOf('/** 둥글게 다듬은 둘레') >= 0 ? base.indexOf('/** 둥글게 다듬은 둘레') : base.indexOf('/** 재해 지대 하나:');
  const b = base.indexOf('/** 자국(골) 하나 그리기');
  const w = await (await fetch('/lab/' + name + '.js?t=' + Date.now())).text();
  const src = base.slice(0, a) + common + '\n' + w + '\n' + base.slice(b) + '\nmodule.exports.__T = Terrain;';
  const m = { exports: {} };
  new Function('module', 'exports', 'require', src)(m, m.exports, () => obsidian);
  const T = m.exports.__T.decode(json);
  const z = T.regions.find((r) => r.type === 'wreck');
  if (z) z.heal = heal;
  const cv = document.createElement('canvas');
  cv.width = 6000;
  cv.height = 4000;
  T.render(cv);
  const out = async (c, nm) => {
    const bl = await new Promise((r) => c.toBlob(r, 'image/png'));
    await fetch('/save?name=' + encodeURIComponent(nm), { method: 'POST', body: bl });
  };
  const sm = document.createElement('canvas');
  sm.width = 1116;
  sm.height = 744;
  const sx = sm.getContext('2d');
  sx.imageSmoothingQuality = 'high';
  sx.drawImage(cv, 0, 0, 1116, 744);
  await out(sm, `lab_${name}_${heal}_small.png`);
  const cc = document.createElement('canvas');
  cc.width = 1000;
  cc.height = 950;
  cc.getContext('2d').drawImage(cv, 1900, 350, 2000, 1900, 0, 0, 1000, 950);
  await out(cc, `lab_${name}_${heal}_crop.png`);
  return name;
};
