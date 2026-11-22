export function windowMinimum(area) {
  return [Math.min(1120, area.width), Math.min(720, area.height)];
}

export function fitWindowBounds(bounds, area) {
  const [minWidth, minHeight] = windowMinimum(area);
  const width = Math.min(area.width, Math.max(minWidth, bounds.width));
  const height = Math.min(area.height, Math.max(minHeight, bounds.height));
  const x = bounds.x ?? Math.round(area.x + (area.width - width) / 2);
  const y = bounds.y ?? Math.round(area.y + (area.height - height) / 2);
  return {
    width, height,
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
  };
}
