/** Прокрутить панель так, чтобы элемент был виден, не трогая страницу. */
export function revealInside(container: HTMLElement, el: HTMLElement) {
  const box = container.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  if (rect.top >= box.top && rect.bottom <= box.bottom) return;
  const top = container.scrollTop + rect.top - box.top - (box.height - rect.height) / 2;
  container.scrollTo({ top: Math.max(0, top) });
}
