import { createLoop } from "./loop.js";

function cardNode(card, index) {
  const item = document.createElement("article");
  item.className = `wall__card wall__card--${card.kind}`;
  item.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "wall__app";
  label.textContent = card.app;
  item.append(label);
  if (card.kind === "image") {
    const image = document.createElement("span");
    image.className = `wall__image wall__image--${index % 5}`;
    item.append(image);
  }
  const body = document.createElement(card.kind === "code" ? "pre" : "span");
  body.className = "wall__body";
  body.textContent = card.body;
  item.append(body);
  return item;
}

export function createWall(el, { cards, reduced = false }) {
  const plane = document.createElement("div");
  plane.className = "wall__plane";
  plane.setAttribute("aria-hidden", "true");
  let tracks = [];
  let columns = 0;
  el.replaceChildren(plane);

  const measure = () => {
    // 流れる 1 列は「同じ束」を縦に重ねたもの。1 束分ずれても面の下端まで埋まる数だけ重ねる
    // (背の高い画面で列の下が途切れないように。面の高さは CSS で表示枠より大きい)
    const planeHeight = plane.getBoundingClientRect().height || innerHeight * 1.6;
    tracks.forEach((item, index) => {
      item.height = Math.max(1, item.first.offsetHeight);
      const sets = Math.max(3, Math.ceil(planeHeight / item.height) + 1);
      while (item.track.children.length < sets) item.track.append(item.first.cloneNode(true));
      while (item.track.children.length > sets) item.track.lastElementChild.remove();
      item.offset = (index * item.height * 0.24) % item.height;
      item.track.style.transform = `translate3d(0, ${-item.offset}px, 0)`;
    });
  };
  const render = () => {
    const nextColumns = innerWidth <= 767 ? 3 : 7;
    if (nextColumns === columns) { measure(); return; }
    columns = nextColumns;
    tracks = [];
    const fragment = document.createDocumentFragment();
    for (let column = 0; column < columns; column++) {
      const col = document.createElement("div");
      col.className = "wall__column";
      const track = document.createElement("div");
      track.className = "wall__track";
      const first = document.createElement("div");
      first.className = "wall__set";
      for (let index = 0; index < 7; index++) {
        const cardIndex = column * 7 + index;
        first.append(cardNode(cards[cardIndex % cards.length], cardIndex));
      }
      track.append(first, first.cloneNode(true), first.cloneNode(true));
      col.append(track);
      fragment.append(col);
      tracks.push({ track, first, offset: 0, height: 1 });
    }
    plane.replaceChildren(fragment);
    measure();
  };
  render();
  let loop = null;
  if (!reduced) {
    loop = createLoop((dt) => {
      for (let i = 0; i < tracks.length; i++) {
        const item = tracks[i];
        item.offset = (item.offset + [18, 23, 20, 26, 19, 24, 21][i] * dt) % item.height;
        item.track.style.transform = `translate3d(0, ${-item.offset}px, 0)`;
      }
      return true;
    }, { root: el });
    loop.wake();
  }
  // reduced でも幅をまたいだら列数を合わせる
  addEventListener("resize", render);

  return {
    destroy() {
      loop?.destroy();
      removeEventListener("resize", render);
      el.replaceChildren();
    },
  };
}
