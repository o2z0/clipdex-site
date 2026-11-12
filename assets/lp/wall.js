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
  const tracks = [];
  for (let column = 0; column < 3; column++) {
    const col = document.createElement("div");
    col.className = "wall__column";
    const track = document.createElement("div");
    track.className = "wall__track";
    const first = document.createElement("div");
    first.className = "wall__set";
    cards.slice(column * 8, column * 8 + 8).forEach((card, index) => first.append(cardNode(card, column * 8 + index)));
    track.append(first, first.cloneNode(true), first.cloneNode(true));
    col.append(track);
    plane.append(col);
    tracks.push({ track, first, offset: 0, height: 1 });
  }
  el.replaceChildren(plane);

  const measure = () => {
    tracks.forEach((item, index) => {
      item.height = Math.max(1, item.first.offsetHeight);
      item.offset = (index * item.height * 0.24) % item.height;
      item.track.style.transform = `translate3d(0, ${-item.offset}px, 0)`;
    });
  };
  measure();
  let loop = null;
  if (!reduced) {
    loop = createLoop((dt) => {
      const count = innerWidth <= 767 ? 2 : 3;
      for (let i = 0; i < count; i++) {
        const item = tracks[i];
        item.offset = (item.offset + [22, 27, 19][i] * dt) % item.height;
        item.track.style.transform = `translate3d(0, ${-item.offset}px, 0)`;
      }
      return true;
    }, { root: el });
    loop.wake();
    addEventListener("resize", measure);
  }

  return {
    destroy() {
      loop?.destroy();
      removeEventListener("resize", measure);
      el.replaceChildren();
    },
  };
}
