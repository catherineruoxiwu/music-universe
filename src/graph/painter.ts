import { type Role } from '../model/types';
import { segmentIntersectsRect, type Camera, type Rect } from './camera';
import type { GraphNode, GraphVisibility } from './graph';
import type { UniverseSnapshot } from './snapshot';

/** Colours for one rendering of the graph. The screen and each poster theme supply their own. */
export interface GraphStyle {
  edge: string;
  edgeHighlight: string;
  label: string;
  labelSecondary: string;
  /** Drawn behind label text so names stay legible over lines. Normally the background colour. */
  labelOutline: string;
  selection: string;
  glow: string;
  roleColors: Record<Role, string>;
  /** CSS font family for names on the map. */
  labelFont: string;
}

/**
 * What is in the spotlight: a person and everyone they are linked to, the two ends of a
 * connection, or everyone credited on one work. Everything else recedes.
 */
export interface Focus {
  /** Per node: part of the spotlight. */
  nodes: boolean[];
  /** Per edge: drawn bright. */
  edges: boolean[];
  /** The node to circle, or -1. */
  ring: number;
}

/** What to draw and how much detail to show. Derived from zoom on screen; fixed for posters. */
export interface DrawOptions {
  visibility: GraphVisibility;
  focus?: Focus | null;
  /** A node the pointer is over, circled lightly. -1 for none. */
  hoverNode?: number;
  /** Size of one layout pixel in canvas units, so strokes and gaps scale with the output. */
  density: number;
  /** 0..1 multiplier on edge opacity; lower when zoomed far out. */
  edgeOpacity: number;
  showLabels: boolean;
  /** Nodes drawn smaller than this get no label, unless among `alwaysLabelTop`. */
  minLabelRadius: number;
  /** The most-credited creators are always named, however small they are drawn. */
  alwaysLabelTop: number;
  maxLabels: number;
  /** Add a second line naming the creator's roles. */
  showRoleLine: boolean;
  /** Soft glows behind communities, for the far zoom level. 0 disables. */
  glowOpacity: number;
  labelSize: number;
  /** Nodes are never drawn smaller than this, so distant ones remain visible as dots. */
  minNodeRadius: number;
  /** Skip anything outside the camera's viewport. Off for posters, which draw everything. */
  cull: boolean;
  /**
   * The role a filter is showing. Anyone who holds it is filled in its colour, so the map agrees
   * with the legend; otherwise a songwriter who also produces would stay songwriter-coloured in a
   * view that claims to show producers.
   */
  emphasisRole: Role | null;
}

const EVERYWHERE: Rect = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };

/**
 * Draws a snapshot through a camera. Used by both the interactive map and the poster renderer, so
 * what is shared is always what the map actually contains.
 */
export class GraphPainter {
  /** Number of edges and nodes drawn by the last `draw` call; used to verify culling. */
  lastEdgesDrawn = 0;
  lastNodesDrawn = 0;

  private placed: Rect[] = [];
  private readonly widths = new Map<string, number>();
  private widthsFont = '';

  constructor(private readonly style: GraphStyle) {}

  draw(ctx: CanvasRenderingContext2D, snapshot: UniverseSnapshot, camera: Camera, options: DrawOptions): void {
    const graph = snapshot.graph;
    const { xs, ys } = snapshot;
    const d = options.density;
    const visible = options.visibility;
    const focus = options.focus ?? null;
    const focusing = focus !== null;
    const hoverNode = options.hoverNode ?? -1;
    const world = options.cull ? camera.visibleWorld() : EVERYWHERE;

    ctx.save();
    if (options.glowOpacity > 0) this.drawGlows(ctx, snapshot, camera, options, world, focusing);

    // --- edges ----------------------------------------------------------------------------------
    let edgesDrawn = 0;
    ctx.lineCap = 'round';
    for (const e of graph.edges) {
      if (!visible.edges[e.index]) continue;
      const ax = xs[e.a];
      const ay = ys[e.a];
      const bx = xs[e.b];
      const by = ys[e.b];
      if (options.cull && !segmentIntersectsRect(ax, ay, bx, by, world)) continue;

      const highlighted = focus !== null && focus.edges[e.index];
      const weightBoost = Math.log(e.weight);
      ctx.globalAlpha = highlighted
        ? 0.95
        : focusing
          ? 0.06 * options.edgeOpacity
          : Math.min(0.22 + 0.16 * weightBoost, 0.7) * options.edgeOpacity;
      ctx.strokeStyle = highlighted ? this.style.edgeHighlight : this.style.edge;
      ctx.lineWidth = Math.max((0.8 + 0.7 * weightBoost + (highlighted ? 0.8 : 0)) * d, 1);
      ctx.beginPath();
      ctx.moveTo(camera.toScreenX(ax), camera.toScreenY(ay));
      ctx.lineTo(camera.toScreenX(bx), camera.toScreenY(by));
      ctx.stroke();
      edgesDrawn++;
    }
    this.lastEdgesDrawn = edgesDrawn;

    // --- nodes ----------------------------------------------------------------------------------
    let nodesDrawn = 0;
    snapshot.index.forEachNear(world.left, world.top, world.right, world.bottom, (i) => {
      if (!visible.nodes[i]) return;
      const node = graph.nodes[i];
      const sx = camera.toScreenX(xs[i]);
      const sy = camera.toScreenY(ys[i]);
      const r = Math.max(node.radius * camera.scale, options.minNodeRadius);
      const alpha = focus !== null && !focus.nodes[i] ? 0.16 : 1;

      const emphasis = options.emphasisRole;
      const fillRole = emphasis !== null && node.hasRole(emphasis) ? emphasis : node.primaryRole;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.style.roleColors[fillRole];
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      // A creator with several roles is still one node: the fill shows the main role and an
      // outer ring is split between all the roles they hold.
      if (r >= 5 * d && node.roles.length > 1) this.drawRoleRing(ctx, node, sx, sy, r, d);

      if (i === focus?.ring || i === hoverNode) {
        ctx.globalAlpha = i === focus?.ring ? 1 : 0.6;
        ctx.strokeStyle = this.style.selection;
        ctx.lineWidth = (i === focus?.ring ? 2 : 1.5) * d;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 6 * d, 0, Math.PI * 2);
        ctx.stroke();
      }
      nodesDrawn++;
    });
    this.lastNodesDrawn = nodesDrawn;

    if (options.showLabels) this.drawLabels(ctx, snapshot, camera, options, focus);
    ctx.restore();
  }

  private drawRoleRing(ctx: CanvasRenderingContext2D, node: GraphNode, sx: number, sy: number, r: number, d: number): void {
    const roles = node.roles;
    const ringRadius = r + 2.5 * d;
    const gap = (10 * Math.PI) / 180;
    const sweep = (Math.PI * 2) / roles.length;
    ctx.lineWidth = 1.6 * d;
    ctx.lineCap = 'butt';
    roles.forEach((role, k) => {
      const start = -Math.PI / 2 + k * sweep + gap / 2;
      ctx.strokeStyle = this.style.roleColors[role];
      ctx.beginPath();
      ctx.arc(sx, sy, ringRadius, start, start + sweep - gap);
      ctx.stroke();
    });
    ctx.lineCap = 'round';
  }

  private drawGlows(
    ctx: CanvasRenderingContext2D,
    snapshot: UniverseSnapshot,
    camera: Camera,
    options: DrawOptions,
    world: Rect,
    focusing: boolean,
  ): void {
    // With something selected the glows recede along with everything that is not in focus.
    ctx.globalAlpha = Math.min(Math.max(options.glowOpacity * (focusing ? 0.3 : 1), 0), 1);
    for (const blob of snapshot.communities) {
      if (
        blob.x + blob.radius < world.left ||
        blob.x - blob.radius > world.right ||
        blob.y + blob.radius < world.top ||
        blob.y - blob.radius > world.bottom
      ) {
        continue;
      }
      // A glow marks a cluster of people; under a filter that hides them it would mark nothing.
      if (blob.members.filter((i) => options.visibility.nodes[i]).length < 2) continue;
      const x = camera.toScreenX(blob.x);
      const y = camera.toScreenY(blob.y);
      const r = blob.radius * camera.scale;
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0, this.style.glow);
      gradient.addColorStop(1, transparent(this.style.glow));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    snapshot: UniverseSnapshot,
    camera: Camera,
    options: DrawOptions,
    focus: Focus | null,
  ): void {
    const graph = snapshot.graph;
    const d = options.density;
    const focusing = focus !== null;
    const textSize = options.labelSize;
    const roleSize = textSize * 0.82;
    const lineHeight = textSize * 1.25;
    const nameFont = `${textSize}px ${this.style.labelFont}`;
    const roleFont = `${roleSize}px ${this.style.labelFont}`;
    if (this.widthsFont !== nameFont) {
      this.widths.clear();
      this.widthsFont = nameFont;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.font = nameFont;

    const placed = this.placed;
    placed.length = 0;
    let count = 0;
    let rank = 0;

    // Two passes when something is selected, so the focused names win the space.
    for (let pass = focusing ? 0 : 1; pass <= 1; pass++) {
      for (const i of graph.nodesByWeight) {
        if (!options.visibility.nodes[i]) continue;
        const inFocus = focus !== null && focus.nodes[i];
        if (pass === 0 && !inFocus) continue;
        if (pass === 1 && inFocus) continue;
        if (pass === 1) rank++;

        const node = graph.nodes[i];
        const sx = camera.toScreenX(snapshot.xs[i]);
        const sy = camera.toScreenY(snapshot.ys[i]);
        if (
          options.cull &&
          (sx < -80 * d || sx > camera.viewWidth + 80 * d || sy < -40 * d || sy > camera.viewHeight + 40 * d)
        ) {
          continue;
        }

        const r = Math.max(node.radius * camera.scale, options.minNodeRadius);
        if (!inFocus) {
          if (count >= options.maxLabels) break;
          if (r < options.minLabelRadius && rank > options.alwaysLabelTop) continue;
        }

        const name = node.label;
        let width = this.widths.get(name);
        if (width === undefined) {
          width = ctx.measureText(name).width;
          this.widths.set(name, width);
        }
        const half = width / 2 + 6 * d;
        const top = sy + r + 4 * d;
        const withRoles = options.showRoleLine && r >= 14 * d;
        const rect: Rect = {
          left: sx - half,
          top,
          right: sx + half,
          bottom: top + lineHeight + (withRoles ? roleSize * 1.3 : 0),
        };
        if (i !== focus?.ring && placed.some((other) => intersects(other, rect))) continue;
        placed.push(rect);
        count++;

        const dim = focusing && !inFocus;
        const baseline = top + textSize;
        ctx.lineWidth = 3 * d;
        ctx.strokeStyle = this.style.labelOutline;
        ctx.globalAlpha = dim ? 0.24 : 1;
        ctx.strokeText(name, sx, baseline);
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.fillStyle = this.style.label;
        ctx.fillText(name, sx, baseline);

        if (withRoles) {
          ctx.font = roleFont;
          ctx.globalAlpha = dim ? 0.24 : 1;
          ctx.strokeText(node.roleLine, sx, baseline + roleSize * 1.3);
          ctx.globalAlpha = dim ? 0.3 : 1;
          ctx.fillStyle = this.style.labelSecondary;
          ctx.fillText(node.roleLine, sx, baseline + roleSize * 1.3);
          ctx.font = nameFont;
        }
      }
    }
  }
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The same colour at zero opacity, so a gradient fades out without shifting hue. */
function transparent(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, 0)`;
}
