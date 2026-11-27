import { Camera, NO_INSETS, distanceSqToSegment, type Insets, type Rect } from './camera';
import { GraphVisibility, NO_FILTER, type GraphEdge, type GraphFilter, type GraphNode } from './graph';
import { GraphPainter, type DrawOptions, type Focus } from './painter';
import { UniverseSnapshot } from './snapshot';
import { SCREEN_STYLE } from './theme';

/** What the map is spotlighting. Held by identity, so it survives the graph being rebuilt. */
export type Selection =
  | { kind: 'creator'; id: string }
  | { kind: 'edge'; a: string; b: string }
  /** Everyone credited on one work. */
  | { kind: 'work'; id: string }
  | null;

/** What the mouse is resting on. */
export type Hover = { node: GraphNode } | { edge: GraphEdge } | null;

/**
 * The view reports what was clicked and leaves it to the host to decide what becomes selected;
 * the host answers with `setSelection`.
 */
export interface UniverseListener {
  onNodeTapped(node: GraphNode): void;
  /** The first tap has already been reported; the second asks to move in on the node. */
  onNodeDoubleTapped(node: GraphNode): void;
  onEdgeTapped(edge: GraphEdge): void;
  onBlankTapped(): void;
  /** Mouse only. `x`, `y` are relative to the canvas. */
  onHover(target: Hover, x: number, y: number): void;
}

/**
 * Zoom thresholds were tuned for the Android app in physical pixels on a 2.625x screen. One CSS
 * pixel is one of that screen's density-independent pixels, so dividing by this keeps the same
 * level of detail at the same apparent size.
 */
const ZOOM_UNIT = 1 / 2.625;
const FAR_SCALE = 0.45;
const NEAR_SCALE = 1.15;
const FOCUS_SCALE = 1.4;
const MAX_FIT_SCALE = 1.2;
const MAX_SCALE = 4;
const REVEAL_MARGIN = 64;
const FLING_DAMPING = 0.55;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 24;
/** The map area of the phone the label budgets were tuned on, in CSS pixels. */
const PHONE_AREA = 411 * 760;

/** How far a pointer may miss a node or a line and still hit it. A finger is blunter than a mouse. */
const slop = (pointerType: string) => (pointerType === 'mouse' ? { node: 4, edge: 5, drag: 3 } : { node: 14, edge: 12, drag: 10 });

/**
 * The pannable, zoomable map.
 *
 * This view owns a camera and nothing else that moves: gestures update the camera and redraw. The
 * graph and its layout arrive ready-made in a snapshot and are only read here.
 */
export class UniverseView {
  listener: UniverseListener | null = null;
  readonly camera = new Camera();

  private snapshot = UniverseSnapshot.EMPTY;
  private filter: GraphFilter = NO_FILTER;
  private visibility = GraphVisibility.compute(this.snapshot.graph, this.filter);

  private selection: Selection = null;
  private focus: Focus | null = null;
  private hoverNode = -1;

  /** Space covered by overlays (title, chips, stats), kept clear when framing the graph. */
  private framePadding: Insets = NO_INSETS;
  private framed = false;
  /** While true, the whole graph is kept framed as the layout moves. Ends at the first gesture. */
  private following = true;
  /** Whether the view shows everything, as fitted, rather than somewhere the user or a selection took it. */
  private fitted = true;
  /** Device pixels per CSS pixel the canvas was last sized for. */
  private ratio = 0;

  private width = 0;
  private height = 0;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly painter = new GraphPainter(SCREEN_STYLE);

  private drawRequest = 0;
  private animation = 0;
  private fling = 0;
  private hoverRequest = 0;
  private hoverX = 0;
  private hoverY = 0;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private dragging = false;
  private pinchDistance = 0;
  private pinchX = 0;
  private pinchY = 0;
  private downX = 0;
  private downY = 0;
  private lastMoveTime = 0;
  private velocityX = 0;
  private velocityY = 0;
  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.measure()).observe(canvas);

    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    canvas.addEventListener('pointerleave', () => this.setHover(null, 0, 0));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('keydown', (e) => this.onKeyDown(e));
    // The browser must not scroll or zoom the page while the map is being dragged or pinched.
    canvas.style.touchAction = 'none';
  }

  // --- public API -----------------------------------------------------------------------------

  setSnapshot(value: UniverseSnapshot): void {
    const firstContent = this.snapshot.graph.nodes.length === 0 && value.graph.nodes.length > 0;
    this.snapshot = value;
    this.visibility = GraphVisibility.compute(value.graph, this.filter);
    this.focus = this.resolveFocus();
    this.hoverNode = -1;
    this.updateScaleLimits();
    if (firstContent) this.framed = false;
    this.frameIfNeeded();
    // A layout still in motion, or a library still growing, would otherwise drift out of a
    // viewpoint chosen for its first frame. A view the user has moved is left where they put it.
    if ((this.following || this.fitted) && this.framed) this.resetView(false);
    if (value.settled) this.following = false;
    this.invalidate();
  }

  setFilter(value: GraphFilter): void {
    if (value.role === this.filter.role && value.sharedOnly === this.filter.sharedOnly) return;
    this.filter = value;
    this.visibility = GraphVisibility.compute(this.snapshot.graph, this.filter);
    this.focus = this.resolveFocus();
    // A view that was showing everything goes on showing everything the filter leaves.
    if (this.fitted && this.framed) this.resetView();
    this.invalidate();
  }

  setFramePadding(padding: Insets): void {
    this.framePadding = padding;
    if (!this.framed) this.frameIfNeeded();
    // What covers the map's edges changed size: fit again, unless the view has been moved.
    else if (this.fitted) this.resetView(false);
  }

  /** The camera is going somewhere other than the fitted view, so stop holding it there. */
  private leaveFraming(): void {
    this.following = false;
    this.fitted = false;
  }

  setSelection(value: Selection): void {
    this.selection = value;
    this.focus = this.resolveFocus();
    this.invalidate();
  }

  /**
   * Whether the selection still has something to show under the current filter and graph. A
   * selection that does not would highlight nothing, so the host should drop it.
   */
  get selectionVisible(): boolean {
    return this.focus !== null;
  }

  /** The nodes the selection spotlights, for framing them. */
  get focusedNodes(): number[] {
    const nodes: number[] = [];
    this.focus?.nodes.forEach((inFocus, i) => inFocus && nodes.push(i));
    return nodes;
  }

  /**
   * Turns the selection into the nodes and edges to light up. Null when there is no selection or
   * the filter hides all of it.
   */
  private resolveFocus(): Focus | null {
    const selection = this.selection;
    if (selection === null) return null;
    const graph = this.snapshot.graph;
    const visible = this.visibility;
    const focus: Focus = { nodes: graph.nodes.map(() => false), edges: graph.edges.map(() => false), ring: -1 };

    if (selection.kind === 'creator') {
      const index = graph.indexOf(selection.id);
      if (index < 0 || !visible.nodes[index]) return null;
      focus.nodes[index] = true;
      focus.ring = index;
      for (const e of graph.adjacency[index]) {
        if (!visible.edges[e]) continue;
        focus.edges[e] = true;
        focus.nodes[graph.edges[e].other(index)] = true;
      }
      return focus;
    }
    if (selection.kind === 'edge') {
      const e = graph.edgeBetween(graph.indexOf(selection.a), graph.indexOf(selection.b));
      if (e < 0 || !visible.edges[e]) return null;
      focus.edges[e] = true;
      focus.nodes[graph.edges[e].a] = true;
      focus.nodes[graph.edges[e].b] = true;
      return focus;
    }
    // A work: everyone the map draws for it, and the links that this work is evidence for.
    let any = false;
    for (const node of graph.nodes) {
      if (visible.nodes[node.index] && node.itemIds.includes(selection.id)) {
        focus.nodes[node.index] = true;
        any = true;
      }
    }
    for (const edge of graph.edges) {
      if (visible.edges[edge.index] && edge.itemIds.includes(selection.id)) focus.edges[edge.index] = true;
    }
    return any ? focus : null;
  }

  /** Frames everything the current filter shows. */
  resetView(animate = true): void {
    if (this.snapshot.graph.nodes.length === 0 || this.width === 0) return;
    const target = new Camera();
    target.copyFrom(this.camera);
    target.fit(this.snapshot.bounds(this.visibility.nodes), this.framePadding, MAX_FIT_SCALE * ZOOM_UNIT);
    if (animate) this.animateCamera(target.centerX, target.centerY, target.scale);
    else this.applyCamera(target.centerX, target.centerY, target.scale);
    this.fitted = true;
  }

  /** Keeps the whole graph framed until the layout now running has settled. */
  followLayout(): void {
    this.following = true;
  }

  /**
   * Glides to a group of nodes and zooms in far enough to read their names, without zooming so
   * far that some of them fall outside.
   *
   * @param covered how much of each side of the map is hidden behind something (the header, the
   *   detail card), so the nodes land in the middle of the part that can actually be seen.
   */
  focusNodes(nodes: number[], covered: Insets = this.framePadding): void {
    if (nodes.length === 0 || this.width === 0) return;
    this.leaveFraming();
    const bounds = this.boundsOf(nodes);
    const free = this.freeArea(covered);
    const fit = Math.min(
      (free.right - free.left) / Math.max(bounds.right - bounds.left, 1e-6),
      (free.bottom - free.top) / Math.max(bounds.bottom - bounds.top, 1e-6),
    );
    const scale = Math.min(Math.max(this.camera.scale, FOCUS_SCALE * ZOOM_UNIT), fit, this.camera.maxScale);
    this.animateCamera(
      (bounds.left + bounds.right) / 2 - ((free.left + free.right) / 2 - this.width / 2) / scale,
      (bounds.top + bounds.bottom) / 2 - ((free.top + free.bottom) / 2 - this.height / 2) / scale,
      scale,
    );
  }

  /**
   * Moves the map only as far as needed for the given nodes to be clear of whatever covers its
   * edges. Does nothing when they already are; zooms out only if they cannot otherwise fit.
   */
  revealNodes(nodes: number[], covered: Insets): void {
    if (nodes.length === 0 || this.width === 0) return;
    const bounds = this.boundsOf(nodes);
    const free = this.freeArea(covered);
    const camera = this.camera;
    const width = (bounds.right - bounds.left) * camera.scale;
    const height = (bounds.bottom - bounds.top) * camera.scale;
    if (width > free.right - free.left || height > free.bottom - free.top) {
      this.focusNodes(nodes, covered);
      return;
    }
    const dx = offsetInto(camera.toScreenX(bounds.left), camera.toScreenX(bounds.right), free.left, free.right);
    const dy = offsetInto(camera.toScreenY(bounds.top), camera.toScreenY(bounds.bottom), free.top, free.bottom);
    if (dx === 0 && dy === 0) return;
    this.leaveFraming();
    this.animateCamera(camera.centerX - dx / camera.scale, camera.centerY - dy / camera.scale, camera.scale);
  }

  /** World bounds of the given nodes, measured at their centres. */
  private boundsOf(nodes: number[]): Rect {
    const { xs, ys } = this.snapshot;
    const bounds: Rect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const i of nodes) {
      bounds.left = Math.min(bounds.left, xs[i]);
      bounds.right = Math.max(bounds.right, xs[i]);
      bounds.top = Math.min(bounds.top, ys[i]);
      bounds.bottom = Math.max(bounds.bottom, ys[i]);
    }
    return bounds;
  }

  /** The part of the view left uncovered, in from the edges by a margin that leaves room for a name. */
  private freeArea(covered: Insets): Rect {
    // On a narrow or short map the margin shrinks rather than leaving no room at all.
    const marginX = Math.min(REVEAL_MARGIN, (this.width - covered.left - covered.right) / 4);
    const marginY = Math.min(REVEAL_MARGIN, (this.height - covered.top - covered.bottom) / 4);
    return {
      left: covered.left + marginX,
      top: covered.top + marginY,
      right: this.width - covered.right - marginX,
      bottom: this.height - covered.bottom - marginY,
    };
  }

  zoomBy(factor: number): void {
    this.leaveFraming();
    this.animateCamera(this.camera.centerX, this.camera.centerY, this.camera.scale * factor);
  }

  // --- drawing --------------------------------------------------------------------------------

  /**
   * Takes the canvas's current size. Runs by itself whenever the size changes; call it directly
   * to have the new size at once, before moving the camera on a map that has just been shown.
   */
  measure(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    // Hidden behind another screen: keep the camera as it is for when the map comes back.
    if (width === 0 || height === 0) return;
    if (width === this.width && height === this.height && this.canvas.width > 0 && this.ratio === (window.devicePixelRatio || 1)) return;
    const ratio = window.devicePixelRatio || 1;
    this.ratio = ratio;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.camera.viewWidth = width;
    this.camera.viewHeight = height;
    this.updateScaleLimits();
    if (!this.framed) this.frameIfNeeded();
    // A window that changes size keeps showing everything, unless the view has been moved.
    else if (this.fitted) this.resetView(false);
    // Drawn at once rather than on the next frame: resizing a canvas clears it.
    this.draw();
  }

  private invalidate(): void {
    if (this.drawRequest) return;
    this.drawRequest = requestAnimationFrame(() => {
      this.drawRequest = 0;
      this.draw();
    });
  }

  private draw(): void {
    if (this.width === 0) return;
    const ratio = this.canvas.width / this.width;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.ctx.clearRect(0, 0, this.width, this.height);
    if (this.snapshot.graph.nodes.length === 0) return;
    this.painter.draw(this.ctx, this.snapshot, this.camera, this.optionsForZoom());
  }

  /**
   * Level of detail follows the zoom continuously: far out shows neighbourhoods and the key
   * names, the middle range brings in the links, and close in shows every name with its roles.
   */
  private optionsForZoom(): DrawOptions {
    const s = this.camera.scale / ZOOM_UNIT;
    const near = s >= NEAR_SCALE;
    const far = s < FAR_SCALE;
    // The label budgets were set for a phone. A larger window has room for proportionally more
    // names; overlapping ones are dropped either way.
    const room = Math.min(Math.max((this.width * this.height) / PHONE_AREA, 1), 4);
    return {
      visibility: this.visibility,
      focus: this.focus,
      hoverNode: this.hoverNode,
      density: 1,
      edgeOpacity: lerp(0.4, 1, (s - 0.2) / 0.7),
      glowOpacity: lerp(0.38, 0, (s - 0.3) / 0.6),
      showLabels: true,
      minLabelRadius: near ? 0 : far ? 11 : 7,
      alwaysLabelTop: Math.round((far ? 8 : 14) * room),
      maxLabels: Math.round((near ? 160 : far ? 16 : 48) * room),
      showRoleLine: near,
      labelSize: 12,
      minNodeRadius: 2,
      cull: true,
      emphasisRole: this.filter.role,
    };
  }

  // --- input ----------------------------------------------------------------------------------

  private point(e: MouseEvent): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.stopMotion();
    this.setHover(null, 0, 0);
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.point(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 1) {
      this.dragging = false;
      this.downX = p.x;
      this.downY = p.y;
      this.velocityX = 0;
      this.velocityY = 0;
      this.lastMoveTime = e.timeStamp;
    } else if (this.pointers.size === 2) {
      this.dragging = true;
      this.startPinch();
    }
  }

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchX = (a.x + b.x) / 2;
    this.pinchY = (a.y + b.y) / 2;
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.point(e);
    const previous = this.pointers.get(e.pointerId);
    if (!previous) {
      if (e.pointerType === 'mouse') this.updateHover(p.x, p.y);
      return;
    }
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const x = (a.x + b.x) / 2;
      const y = (a.y + b.y) / 2;
      if (this.pinchDistance > 0 && distance > 0) this.camera.zoomBy(distance / this.pinchDistance, x, y);
      this.camera.panByPixels(x - this.pinchX, y - this.pinchY);
      this.pinchDistance = distance;
      this.pinchX = x;
      this.pinchY = y;
      this.moved();
      return;
    }

    if (!this.dragging) {
      if (Math.hypot(p.x - this.downX, p.y - this.downY) < slop(e.pointerType).drag) return;
      this.dragging = true;
      this.canvas.style.cursor = 'grabbing';
    }
    const dx = p.x - previous.x;
    const dy = p.y - previous.y;
    this.camera.panByPixels(dx, dy);
    const dt = Math.max(e.timeStamp - this.lastMoveTime, 1);
    // Smoothed, so one jittery sample at the end of a drag does not decide the momentum.
    this.velocityX = this.velocityX * 0.6 + (dx / dt) * 0.4;
    this.velocityY = this.velocityY * 0.6 + (dy / dt) * 0.4;
    this.lastMoveTime = e.timeStamp;
    this.moved();
  }

  private onPointerUp(e: PointerEvent, cancelled = false): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size > 0) {
      // One finger of a pinch lifted: carry on as a drag from where the other finger is.
      if (this.pointers.size >= 2) this.startPinch();
      this.velocityX = 0;
      this.velocityY = 0;
      return;
    }
    this.canvas.style.cursor = '';
    if (cancelled) return;
    const p = this.point(e);
    if (!this.dragging) {
      this.onTap(p.x, p.y, e.pointerType, e.timeStamp);
    } else if (e.timeStamp - this.lastMoveTime < 60 && Math.hypot(this.velocityX, this.velocityY) > 0.3) {
      this.startFling();
    }
    this.dragging = false;
  }

  private onTap(x: number, y: number, pointerType: string, time: number): void {
    const double =
      time - this.lastTapTime < DOUBLE_TAP_MS && Math.hypot(x - this.lastTapX, y - this.lastTapY) < DOUBLE_TAP_DISTANCE;
    this.lastTapTime = double ? 0 : time;
    this.lastTapX = x;
    this.lastTapY = y;

    const node = this.nodeAt(x, y, pointerType);
    if (double) {
      this.leaveFraming();
      if (node >= 0) this.listener?.onNodeDoubleTapped(this.snapshot.graph.nodes[node]);
      else this.animateCamera(this.camera.toWorldX(x), this.camera.toWorldY(y), this.camera.scale * 1.8);
      return;
    }
    if (node >= 0) {
      this.listener?.onNodeTapped(this.snapshot.graph.nodes[node]);
      return;
    }
    const edge = this.edgeAt(x, y, pointerType);
    if (edge >= 0) this.listener?.onEdgeTapped(this.snapshot.graph.edges[edge]);
    else this.listener?.onBlankTapped();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.stopMotion();
    const p = this.point(e);
    const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    // A trackpad pinch arrives as a wheel event with ctrlKey set and much smaller deltas.
    const speed = e.ctrlKey ? 0.01 : 0.0015;
    this.camera.zoomBy(Math.exp(-e.deltaY * lines * speed), p.x, p.y);
    this.moved();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const step = 80;
    switch (e.key) {
      case 'ArrowLeft':
        this.camera.panByPixels(step, 0);
        break;
      case 'ArrowRight':
        this.camera.panByPixels(-step, 0);
        break;
      case 'ArrowUp':
        this.camera.panByPixels(0, step);
        break;
      case 'ArrowDown':
        this.camera.panByPixels(0, -step);
        break;
      case '+':
      case '=':
        this.zoomBy(1.4);
        break;
      case '-':
        this.zoomBy(1 / 1.4);
        break;
      case '0':
        this.resetView();
        break;
      default:
        return;
    }
    e.preventDefault();
    this.moved();
  }

  /** Common end of every gesture that changed the camera. */
  private moved(): void {
    this.leaveFraming();
    this.clampCamera();
    this.invalidate();
  }

  /** Hit-tests at most once per frame, however fast the mouse moves. */
  private updateHover(x: number, y: number): void {
    this.hoverX = x;
    this.hoverY = y;
    if (this.hoverRequest) return;
    this.hoverRequest = requestAnimationFrame(() => {
      this.hoverRequest = 0;
      if (this.pointers.size > 0) return;
      const graph = this.snapshot.graph;
      const node = this.nodeAt(this.hoverX, this.hoverY, 'mouse');
      const edge = node >= 0 ? -1 : this.edgeAt(this.hoverX, this.hoverY, 'mouse');
      this.setHover(node >= 0 ? { node: graph.nodes[node] } : edge >= 0 ? { edge: graph.edges[edge] } : null, this.hoverX, this.hoverY);
    });
  }

  private setHover(target: Hover, x: number, y: number): void {
    const node = target !== null && 'node' in target ? target.node.index : -1;
    if (node !== this.hoverNode) {
      this.hoverNode = node;
      this.invalidate();
    }
    this.canvas.style.cursor = target === null ? '' : 'pointer';
    this.listener?.onHover(target, x, y);
  }

  private nodeAt(x: number, y: number, pointerType: string): number {
    const slopWorld = slop(pointerType).node / this.camera.scale;
    return this.snapshot.index.hit(this.camera.toWorldX(x), this.camera.toWorldY(y), slopWorld, this.visibility.nodes);
  }

  private edgeAt(x: number, y: number, pointerType: string): number {
    const reach = slop(pointerType).edge;
    const { xs, ys, graph } = this.snapshot;
    let best = -1;
    let bestDistance = reach * reach;
    for (const e of graph.edges) {
      if (!this.visibility.edges[e.index]) continue;
      const d = distanceSqToSegment(
        x,
        y,
        this.camera.toScreenX(xs[e.a]),
        this.camera.toScreenY(ys[e.a]),
        this.camera.toScreenX(xs[e.b]),
        this.camera.toScreenY(ys[e.b]),
      );
      if (d < bestDistance) {
        bestDistance = d;
        best = e.index;
      }
    }
    return best;
  }

  // --- camera ---------------------------------------------------------------------------------

  private frameIfNeeded(): void {
    if (this.framed || this.width === 0 || this.snapshot.graph.nodes.length === 0) return;
    this.resetView(false);
    this.framed = true;
  }

  private updateScaleLimits(): void {
    if (this.snapshot.graph.nodes.length === 0 || this.width === 0) return;
    const fit = this.camera.scaleToFit(this.snapshot.fullBounds);
    // Allow zooming out a little past "everything visible", and no further.
    this.camera.minScale = Math.min(fit * 0.6, 0.5 * ZOOM_UNIT);
    this.camera.maxScale = MAX_SCALE * ZOOM_UNIT;
    this.camera.setScale(this.camera.scale);
  }

  /** Keeps the centre of the screen over the graph, so the map can never be lost off-screen. */
  private clampCamera(): void {
    if (this.snapshot.graph.nodes.length === 0) return;
    const b = this.snapshot.fullBounds;
    this.camera.centerX = Math.min(Math.max(this.camera.centerX, b.left), b.right);
    this.camera.centerY = Math.min(Math.max(this.camera.centerY, b.top), b.bottom);
  }

  private stopMotion(): void {
    cancelAnimationFrame(this.animation);
    cancelAnimationFrame(this.fling);
    this.animation = 0;
    this.fling = 0;
  }

  private applyCamera(x: number, y: number, scale: number): void {
    this.stopMotion();
    this.camera.setScale(scale);
    this.camera.centerX = x;
    this.camera.centerY = y;
    this.clampCamera();
    this.invalidate();
  }

  private animateCamera(x: number, y: number, scale: number): void {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.applyCamera(x, y, scale);
      return;
    }
    this.stopMotion();
    const camera = this.camera;
    const fromX = camera.centerX;
    const fromY = camera.centerY;
    // Interpolating the logarithm makes zoom feel even from start to finish.
    const fromLog = Math.log(camera.scale);
    const toLog = Math.log(Math.min(Math.max(scale, camera.minScale), camera.maxScale));
    const start = performance.now();
    const frame = (now: number) => {
      const linear = Math.min((now - start) / 420, 1);
      const t = 1 - Math.pow(1 - linear, 3.2);
      camera.setScale(Math.exp(fromLog + (toLog - fromLog) * t));
      camera.centerX = fromX + (x - fromX) * t;
      camera.centerY = fromY + (y - fromY) * t;
      this.invalidate();
      this.animation = linear < 1 ? requestAnimationFrame(frame) : 0;
    };
    this.animation = requestAnimationFrame(frame);
  }

  /** Deliberately gentle: a nudge of momentum, not a long glide across the map. */
  private startFling(): void {
    let vx = this.velocityX * FLING_DAMPING;
    let vy = this.velocityY * FLING_DAMPING;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(now - last, 50);
      last = now;
      this.camera.panByPixels(vx * dt, vy * dt);
      this.clampCamera();
      this.invalidate();
      const decay = Math.exp(-dt / 180);
      vx *= decay;
      vy *= decay;
      this.fling = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(frame) : 0;
    };
    this.fling = requestAnimationFrame(frame);
  }
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * Math.min(Math.max(t, 0), 1);
}

/** How far the span [from, to] has to move to lie within [min, max]; zero when it already does. */
function offsetInto(from: number, to: number, min: number, max: number): number {
  return from < min ? min - from : to > max ? max - to : 0;
}
