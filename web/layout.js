'use strict';

// 3x3 スクロールレイアウトの制御。
// 中央 = ゲーム画面 / 上 = ツールバー / 下 = 端子パネル / 左右 = デバッグパネル。
// 周辺パネルは画面外にあり、スワイプ(スクロール)か端のタブで引き出す。
(() => {
  const app = document.getElementById('app');
  const stage = document.getElementById('stage');
  const hints = {
    up: document.getElementById('hint-up'),
    down: document.getElementById('hint-down'),
    left: document.getElementById('hint-left'),
    right: document.getElementById('hint-right'),
  };

  const maxX = () => app.scrollWidth - app.clientWidth;
  const maxY = () => app.scrollHeight - app.clientHeight;

  // 中央(ステージ)のスクロール位置
  function stagePos() {
    const a = app.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    return { x: app.scrollLeft + (s.left - a.left), y: app.scrollTop + (s.top - a.top) };
  }

  function center(smooth) {
    const p = stagePos();
    app.scrollTo({ left: p.x, top: p.y, behavior: smooth ? 'smooth' : 'auto' });
  }
  window.recenterStage = center;

  function updateHints() {
    const x = app.scrollLeft, y = app.scrollTop;
    hints.up.classList.toggle('on', y > 2);
    hints.down.classList.toggle('on', y < maxY() - 2);
    hints.left.classList.toggle('on', x > 2);
    hints.right.classList.toggle('on', x < maxX() - 2);
  }

  // 端のタブ: その方向の次のスナップ位置へ1段だけ動かす
  function step(dir) {
    const p = stagePos();
    const vert = dir === 'up' || dir === 'down';
    const stops = vert ? [0, p.y, maxY()] : [0, p.x, maxX()];
    const cur = vert ? app.scrollTop : app.scrollLeft;
    const fwd = dir === 'down' || dir === 'right';
    const cand = stops.filter((v) => (fwd ? v > cur + 2 : v < cur - 2));
    if (!cand.length) return;
    const to = fwd ? Math.min(...cand) : Math.max(...cand);
    app.scrollTo(vert ? { top: to, behavior: 'smooth' } : { left: to, behavior: 'smooth' });
  }
  for (const dir of Object.keys(hints)) {
    hints[dir].addEventListener('click', () => step(dir));
  }

  app.addEventListener('scroll', updateHints, { passive: true });
  window.addEventListener('resize', () => { center(false); updateHints(); });

  // パネルの表示/非表示 (DEBUG / 端子ボタン) でグリッドの大きさが変わるので中央に戻す
  let prev = '';
  const panelState = () =>
    (document.body.classList.contains('debug-on') ? 'D' : '') +
    (document.body.classList.contains('bus-on') ? 'B' : '');
  prev = panelState();
  new MutationObserver(() => {
    const now = panelState();
    if (now === prev) return;
    prev = now;
    requestAnimationFrame(() => { center(false); updateHints(); });
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  center(false);
  updateHints();
  // レイアウト確定後(フォント/WASM ロード後)にもう一度中央合わせ
  window.addEventListener('load', () => { center(false); updateHints(); });
})();
