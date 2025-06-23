import { moduleId } from "./constants.js";

export function getSetting(key) {
  return game.settings.get(moduleId, key);
}

export function distanceBetween(token0, token1) {
  const ray = new foundry.canvas.geometry.Ray(
    new PIXI.Point(token0?.x || 0, token0?.y || 0),
    new PIXI.Point(token1?.x || 0, token1?.y || 0)
  );
  const x = Math.ceil(Math.abs(ray.dx / canvas.dimensions.size));
  const y = Math.ceil(Math.abs(ray.dy / canvas.dimensions.size));
  return (
    Math.floor(Math.min(x, y) + Math.abs(y - x)) * canvas.dimensions.distance
  );
}
