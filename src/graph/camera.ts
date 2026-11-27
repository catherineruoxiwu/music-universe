export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Space taken on each side of a view, in pixels. */
export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const NO_INSETS: Insets = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * Maps world coordinates to pixels. Panning and zooming change only this object; node positions
 * and the layout are never touched by a gesture.
 *
 * (`centerX`, `centerY`) is the world point shown at the middle of the viewport, and `scale` is
 * pixels per world unit.
 */
export class Camera {
  centerX = 0;
  centerY = 0;
  viewWidth = 1;
  viewHeight = 1;
  minScale = 0.02;
  maxScale = 4;

  private _scale = 1;

  get scale(): number {
    return this._scale;
  }

  setScale(value: number): void {
    this._scale = Math.min(Math.max(value, this.minScale), this.maxScale);
  }

  toScreenX(worldX: number): number {
    return (worldX - this.centerX) * this._scale + this.viewWidth / 2;
  }

  toScreenY(worldY: number): number {
    return (worldY - this.centerY) * this._scale + this.viewHeight / 2;
  }

  toWorldX(screenX: number): number {
    return (screenX - this.viewWidth / 2) / this._scale + this.centerX;
  }

  toWorldY(screenY: number): number {
    return (screenY - this.viewHeight / 2) / this._scale + this.centerY;
  }

  panByPixels(dx: number, dy: number): void {
    this.centerX -= dx / this._scale;
    this.centerY -= dy / this._scale;
  }

  /** Zooms so the world point under (`focusX`, `focusY`) stays under the pointer. */
  zoomBy(factor: number, focusX: number, focusY: number): void {
    const worldX = this.toWorldX(focusX);
    const worldY = this.toWorldY(focusY);
    this.setScale(this._scale * factor);
    this.centerX = worldX - (focusX - this.viewWidth / 2) / this._scale;
    this.centerY = worldY - (focusY - this.viewHeight / 2) / this._scale;
  }

  /** The world rectangle currently on screen. */
  visibleWorld(): Rect {
    return {
      left: this.toWorldX(0),
      top: this.toWorldY(0),
      right: this.toWorldX(this.viewWidth),
      bottom: this.toWorldY(this.viewHeight),
    };
  }

  /** The scale at which `bounds` fills the viewport, leaving the given padding. */
  scaleToFit(bounds: Rect, pad: Insets = NO_INSETS): number {
    const w = Math.max(this.viewWidth - pad.left - pad.right, 1);
    const h = Math.max(this.viewHeight - pad.top - pad.bottom, 1);
    return Math.min(w / Math.max(bounds.right - bounds.left, 1), h / Math.max(bounds.bottom - bounds.top, 1));
  }

  /** Frames `bounds` inside the padded viewport. */
  fit(bounds: Rect, pad: Insets, maxFitScale: number): void {
    this.setScale(Math.min(this.scaleToFit(bounds, pad), maxFitScale));
    // Offset so the bounds centre lands in the middle of the padded area, not of the view.
    this.centerX = (bounds.left + bounds.right) / 2 - (pad.left - pad.right) / 2 / this._scale;
    this.centerY = (bounds.top + bounds.bottom) / 2 - (pad.top - pad.bottom) / 2 / this._scale;
  }

  copyFrom(other: Camera): void {
    this.centerX = other.centerX;
    this.centerY = other.centerY;
    this.viewWidth = other.viewWidth;
    this.viewHeight = other.viewHeight;
    this.minScale = other.minScale;
    this.maxScale = other.maxScale;
    this._scale = other._scale;
  }
}

/**
 * Whether the segment (ax,ay)-(bx,by) touches the rectangle. Handles the case that matters for
 * culling edges: both endpoints off screen, but the line passes through the viewport.
 * (Liang-Barsky clipping.)
 */
export function segmentIntersectsRect(ax: number, ay: number, bx: number, by: number, r: Rect): boolean {
  if (Math.max(ax, bx) < r.left || Math.min(ax, bx) > r.right || Math.max(ay, by) < r.top || Math.min(ay, by) > r.bottom) {
    return false;
  }
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const sides: [number, number][] = [
    [-dx, ax - r.left],
    [dx, r.right - ax],
    [-dy, ay - r.top],
    [dy, r.bottom - ay],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

/** Squared distance from point (px,py) to the segment (ax,ay)-(bx,by). */
export function distanceSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / lenSq, 0), 1);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}
